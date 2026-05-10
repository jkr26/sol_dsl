#!/usr/bin/env node
"use strict";

// Patch uuid ESM issue on Node 18
const Module = require("module");
const _resolveFilename = Module._resolveFilename.bind(Module);
Module._resolveFilename = (req, ...rest) => {
  // If rpc-websockets requests uuid, redirect to the top-level cjs build
  if (req === "uuid" || req.startsWith("uuid/")) {
    try {
      return _resolveFilename(
        req.replace("uuid", require.resolve("uuid").replace(/\/dist.*/, "")),
        ...rest
      );
    } catch (_) {}
  }
  return _resolveFilename(req, ...rest);
};

const anchor = require("@coral-xyz/anchor");
const web3 = anchor.web3;
const { BN } = anchor;
const assert = require("assert");

const IDL = require("../skill/idl.json");
const PROGRAM_ID = new web3.PublicKey("GJYEW4jBbBZTVNTdG2AB3EHjC39hFuWWZjaxvDUpmZ3i");
const CHAINLINK_PROGRAM = new web3.PublicKey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
const CHAINLINK_FEED    = new web3.PublicKey("HgTtcbcmp5BeThax5AU8vg4VwK79qAvAKKFMs8txMLW6");

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message ?? e}`);
    failed++;
  }
}

function makeWallet(kp) {
  return {
    publicKey: kp.publicKey,
    signTransaction:     async (tx) => { tx.partialSign(kp); return tx; },
    signAllTransactions: async (txs) => { txs.forEach(tx => tx.partialSign(kp)); return txs; },
  };
}

async function airdrop(conn, pk, lamports) {
  const sig = await conn.requestAirdrop(pk, lamports);
  await conn.confirmTransaction(sig, "confirmed");
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const connection = new web3.Connection("http://127.0.0.1:8899", "confirmed");

  // ── keypairs ────────────────────────────────────────────────────────────────
  const proposer      = web3.Keypair.generate();
  const counterparty  = web3.Keypair.generate();
  const randomSettler = web3.Keypair.generate();

  console.log("\nFunding wallets…");
  await airdrop(connection, proposer.publicKey,     5_000_000_000);
  await airdrop(connection, counterparty.publicKey, 5_000_000_000);
  await airdrop(connection, randomSettler.publicKey,    500_000_000);

  // proposer acts as the tx payer/signer for program calls
  const provider = new anchor.AnchorProvider(connection, makeWallet(proposer), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(IDL, provider);

  // ── derive wager PDA ────────────────────────────────────────────────────────
  const [wagerPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), proposer.publicKey.toBuffer(), counterparty.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const currentSlot = await connection.getSlot("confirmed");
  console.log(`\nCurrent slot: ${currentSlot}`);
  console.log("Proposer:     ", proposer.publicKey.toBase58());
  console.log("Counterparty: ", counterparty.publicKey.toBase58());
  console.log("Wager PDA:    ", wagerPda.toBase58());

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 1: initialize_wager
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 1: initialize_wager ──");

  await test("creates wager PDA with correct state", async () => {
    const params = {
      condition:       { priceAbove: {} },
      threshold:       new BN("10000000000"),  // $100 (8 decimals)
      thresholdMin:    new BN(0),
      thresholdMax:    new BN(0),
      changePct:       0,
      snapshotPrice:   new BN(0),
      expirySlot:      new BN(currentSlot + 200),
      proposerStake:   new BN(1_000_000_000),  // 1 SOL
      counterpartyStake: new BN(500_000_000),  // 0.5 SOL
    };

    await program.methods
      .initializeWager(params)
      .accounts({
        proposer:      proposer.publicKey,
        counterparty:  counterparty.publicKey,
        wager:         wagerPda,
        chainlinkFeed: CHAINLINK_FEED,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([proposer, counterparty])
      .rpc();

    const w = await program.account.wager.fetch(wagerPda);
    assert.equal(w.proposer.toBase58(),     proposer.publicKey.toBase58());
    assert.equal(w.counterparty.toBase58(), counterparty.publicKey.toBase58());
    assert.equal(w.oracleFeed.toBase58(),   CHAINLINK_FEED.toBase58());
    assert.deepStrictEqual(w.condition,     { priceAbove: {} });
    assert.equal(w.threshold.toString(),    "10000000000");
    assert.equal(w.expirySlot.toString(),   String(currentSlot + 200));
    assert.equal(w.proposerStake.toString(),    "1000000000");
    assert.equal(w.counterpartyStake.toString(), "500000000");
    assert.deepStrictEqual(w.state,         { active: {} });
  });

  await test("escrows both stakes into PDA", async () => {
    const wagerBal = await connection.getBalance(wagerPda);
    // Wager should hold proposerStake + counterpartyStake + rent
    assert(wagerBal >= 1_500_000_000, `expected ≥ 1.5 SOL, got ${wagerBal}`);
    console.log(`     PDA balance: ${(wagerBal / 1e9).toFixed(4)} SOL`);
  });

  await test("rejects zero proposer stake", async () => {
    const p2 = web3.Keypair.generate();
    await airdrop(connection, p2.publicKey, 2_000_000_000);
    const [pda2] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), p2.publicKey.toBuffer(), counterparty.publicKey.toBuffer()],
      PROGRAM_ID
    );
    try {
      await program.methods
        .initializeWager({
          condition: { priceBelow: {} },
          threshold: new BN(1), thresholdMin: new BN(0), thresholdMax: new BN(0),
          changePct: 0, snapshotPrice: new BN(0),
          expirySlot: new BN(currentSlot + 100),
          proposerStake: new BN(0), counterpartyStake: new BN(1),
        })
        .accounts({
          proposer: p2.publicKey, counterparty: counterparty.publicKey,
          wager: pda2, chainlinkFeed: CHAINLINK_FEED,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([p2, counterparty]).rpc();
      assert.fail("should have thrown ZeroStake");
    } catch (e) {
      assert(String(e).includes("ZeroStake"), `wrong error: ${e}`);
    }
  });

  await test("rejects invalid PriceBetween band (min >= max)", async () => {
    const p3 = web3.Keypair.generate();
    await airdrop(connection, p3.publicKey, 2_000_000_000);
    const [pda3] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), p3.publicKey.toBuffer(), counterparty.publicKey.toBuffer()],
      PROGRAM_ID
    );
    try {
      await program.methods
        .initializeWager({
          condition: { priceBetween: {} },
          threshold: new BN(0), thresholdMin: new BN(200), thresholdMax: new BN(100),
          changePct: 0, snapshotPrice: new BN(0),
          expirySlot: new BN(currentSlot + 100),
          proposerStake: new BN(1_000_000), counterpartyStake: new BN(1_000_000),
        })
        .accounts({
          proposer: p3.publicKey, counterparty: counterparty.publicKey,
          wager: pda3, chainlinkFeed: CHAINLINK_FEED,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([p3, counterparty]).rpc();
      assert.fail("should have thrown InvalidBand");
    } catch (e) {
      assert(String(e).includes("InvalidBand"), `wrong error: ${e}`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 2: settle_wager — expiry guards
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 2: settle_wager guards ──");

  await test("rejects settlement before expiry", async () => {
    try {
      await program.methods
        .settleWager()
        .accounts({
          wager:          wagerPda,
          proposer:       proposer.publicKey,
          counterparty:   counterparty.publicKey,
          winner:         proposer.publicKey,
          chainlinkFeed:  CHAINLINK_FEED,
          chainlinkProgram: CHAINLINK_PROGRAM,
          systemProgram:  web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("should have thrown NotExpiredYet");
    } catch (e) {
      assert(String(e).includes("NotExpiredYet"), `wrong error: ${e}`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 3: full settle with cloned Chainlink feed
  // (separate wager with expiry in the past so it triggers oracle evaluation)
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 3: full settle via Chainlink oracle ──");

  const p4 = web3.Keypair.generate();
  const c4 = web3.Keypair.generate();
  await airdrop(connection, p4.publicKey, 5_000_000_000);
  await airdrop(connection, c4.publicKey, 5_000_000_000);

  const [settlePda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("wager"), p4.publicKey.toBuffer(), c4.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const settleProvider = new anchor.AnchorProvider(connection, makeWallet(p4), {
    commitment: "confirmed",
  });
  const settleProgram = new anchor.Program(IDL, settleProvider);

  const slotNow = await connection.getSlot("confirmed");

  await test("creates short-lived wager (expiry = current slot + 5)", async () => {
    await settleProgram.methods
      .initializeWager({
        condition: { priceAbove: {} },
        threshold: new BN("1"),         // $0.00000001 — any real price is above this
        thresholdMin: new BN(0), thresholdMax: new BN(0),
        changePct: 0, snapshotPrice: new BN(0),
        expirySlot: new BN(slotNow + 5),
        proposerStake:   new BN(500_000_000),
        counterpartyStake: new BN(500_000_000),
      })
      .accounts({
        proposer: p4.publicKey, counterparty: c4.publicKey,
        wager: settlePda, chainlinkFeed: CHAINLINK_FEED,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([p4, c4]).rpc();

    const w = await settleProgram.account.wager.fetch(settlePda);
    assert.deepStrictEqual(w.state, { active: {} });
    console.log(`     Wager expires at slot ${slotNow + 5}`);
  });

  await test("waits for expiry slot", async () => {
    let slot = await connection.getSlot("confirmed");
    while (slot < slotNow + 5) {
      await sleep(400);
      slot = await connection.getSlot("confirmed");
    }
    console.log(`     Now at slot ${slot}`);
  });

  await test("settles wager — proposer wins (price > $0.00000001)", async () => {
    const p4BalBefore = await connection.getBalance(p4.publicKey);

    await settleProgram.methods
      .settleWager()
      .accounts({
        wager:           settlePda,
        proposer:        p4.publicKey,
        counterparty:    c4.publicKey,
        winner:          p4.publicKey,    // proposer wins when price > 1
        chainlinkFeed:   CHAINLINK_FEED,
        chainlinkProgram: CHAINLINK_PROGRAM,
        systemProgram:   web3.SystemProgram.programId,
      })
      .rpc();

    // PDA should be closed
    const pdaInfo = await connection.getAccountInfo(settlePda);
    assert.equal(pdaInfo, null, "wager PDA should be closed");

    const p4BalAfter = await connection.getBalance(p4.publicKey);
    const gained = p4BalAfter - p4BalBefore;
    console.log(`     Proposer gained ${(gained / 1e9).toFixed(4)} SOL (winnings + returned stake + rent)`);
    assert(gained > 0, "proposer should have gained SOL");
  });

  await test("settles wager — WrongWinner rejected when wrong party given", async () => {
    // Create another wager
    const p5 = web3.Keypair.generate(), c5 = web3.Keypair.generate();
    await airdrop(connection, p5.publicKey, 3_000_000_000);
    await airdrop(connection, c5.publicKey, 3_000_000_000);
    const [pda5] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), p5.publicKey.toBuffer(), c5.publicKey.toBuffer()],
      PROGRAM_ID
    );
    const prog5 = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(p5), {}));
    const slot5 = await connection.getSlot("confirmed");
    await prog5.methods
      .initializeWager({
        condition: { priceAbove: {} },
        threshold: new BN("1"),
        thresholdMin: new BN(0), thresholdMax: new BN(0),
        changePct: 0, snapshotPrice: new BN(0),
        expirySlot: new BN(slot5 + 3),
        proposerStake: new BN(500_000_000), counterpartyStake: new BN(500_000_000),
      })
      .accounts({ proposer: p5.publicKey, counterparty: c5.publicKey, wager: pda5, chainlinkFeed: CHAINLINK_FEED, systemProgram: web3.SystemProgram.programId })
      .signers([p5, c5]).rpc();

    let s = await connection.getSlot("confirmed");
    while (s < slot5 + 3) { await sleep(400); s = await connection.getSlot("confirmed"); }

    try {
      await prog5.methods.settleWager()
        .accounts({ wager: pda5, proposer: p5.publicKey, counterparty: c5.publicKey,
          winner: c5.publicKey,   // WRONG: price > $0 so proposer wins, not counterparty
          chainlinkFeed: CHAINLINK_FEED, chainlinkProgram: CHAINLINK_PROGRAM,
          systemProgram: web3.SystemProgram.programId })
        .rpc();
      assert.fail("should have thrown WrongWinner");
    } catch (e) {
      assert(String(e).includes("WrongWinner"), `wrong error: ${e}`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 4: verify/index.js — DSL ↔ transaction matching
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 4: verify/index.js ──");

  await test("verifyWagerTransaction matches a real tx", async () => {
    const { verifyWagerTransaction } = require("../verify");

    // Build+sign a tx but don't send it — capture the serialised bytes
    const vp = web3.Keypair.generate(), vc = web3.Keypair.generate();
    await airdrop(connection, vp.publicKey, 3_000_000_000);
    await airdrop(connection, vc.publicKey, 3_000_000_000);
    const [vpda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), vp.publicKey.toBuffer(), vc.publicKey.toBuffer()], PROGRAM_ID
    );
    const vprov = new anchor.AnchorProvider(connection, makeWallet(vp), {});
    const vprog = new anchor.Program(IDL, vprov);

    const slot6 = await connection.getSlot("confirmed");
    const verifyParams = {
      condition: { priceAbove: {} },
      threshold: new BN("10000000000"),
      thresholdMin: new BN(0), thresholdMax: new BN(0),
      changePct: 0, snapshotPrice: new BN(0),
      expirySlot: new BN(slot6 + 100),
      proposerStake: new BN(1_000_000_000),
      counterpartyStake: new BN(500_000_000),
    };

    // Build the tx without sending to get serialised bytes
    const { blockhash } = await connection.getLatestBlockhash();
    const ix = await vprog.methods.initializeWager(verifyParams)
      .accounts({ proposer: vp.publicKey, counterparty: vc.publicKey, wager: vpda,
        chainlinkFeed: CHAINLINK_FEED, systemProgram: web3.SystemProgram.programId })
      .instruction();
    const tx = new web3.Transaction({ recentBlockhash: blockhash, feePayer: vp.publicKey });
    tx.add(ix);
    tx.partialSign(vp, vc);
    const txHex = tx.serialize({ requireAllSignatures: false }).toString("hex");

    const dsl = {
      version: "1",
      program_id: PROGRAM_ID.toBase58(),
      proposer:     vp.publicKey.toBase58(),
      counterparty: vc.publicKey.toBase58(),
      oracle_feed:  CHAINLINK_FEED.toBase58(),
      condition: "PRICE_ABOVE",
      threshold: "10000000000",
      expiry_slot: String(slot6 + 100),
      proposer_stake:     "1000000000",
      counterparty_stake: "500000000",
    };

    const result = verifyWagerTransaction(txHex, dsl);
    assert.equal(result.ok, true, `verify failed: ${JSON.stringify(result.errors)}`);
    console.log("     errors:", result.errors.length === 0 ? "none" : result.errors);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 5: discovery — propose_wager / accept_wager / cancel_proposal
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 5: discovery — open proposals ──");

  const dp = web3.Keypair.generate(), dc = web3.Keypair.generate();
  await airdrop(connection, dp.publicKey, 5_000_000_000);
  await airdrop(connection, dc.publicKey, 5_000_000_000);

  const [proposalPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), dp.publicKey.toBuffer()], PROGRAM_ID
  );
  const dprog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(dp), {}));
  const dcprog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(dc), {}));

  let discoveryExpirySlot;

  await test("propose_wager creates WagerProposal on-chain (single sig)", async () => {
    const slot = await connection.getSlot("confirmed");
    discoveryExpirySlot = slot + 30;
    await dprog.methods
      .proposeWager({
        condition: { priceAbove: {} },
        threshold: new BN("1"),
        thresholdMin: new BN(0), thresholdMax: new BN(0),
        changePct: 0, snapshotPrice: new BN(0),
        expirySlot: new BN(discoveryExpirySlot),
        proposerStake: new BN(300_000_000),
        counterpartyStake: new BN(300_000_000),
      })
      .accounts({
        proposer: dp.publicKey,
        proposal: proposalPda,
        oracleFeed: CHAINLINK_FEED,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    const p = await dprog.account.wagerProposal.fetch(proposalPda);
    assert.equal(p.proposer.toBase58(), dp.publicKey.toBase58());
    assert.equal(p.proposerStake.toNumber(), 300_000_000);
    assert.equal(p.counterpartyStake.toNumber(), 300_000_000);
    assert.deepStrictEqual(p.condition, { priceAbove: {} });
    console.log(`     Proposal PDA: ${proposalPda.toBase58()}`);
  });

  await test("getProgramAccounts finds the open proposal", async () => {
    const all = await dprog.account.wagerProposal.all();
    const found = all.find(p => p.publicKey.toBase58() === proposalPda.toBase58());
    assert(found, "proposal not found in getProgramAccounts");
    console.log(`     Found ${all.length} total proposal(s) on-chain`);
  });

  await test("accept_wager converts proposal → active Wager", async () => {
    const [wagerPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("wager"), dp.publicKey.toBuffer(), dc.publicKey.toBuffer()], PROGRAM_ID
    );

    const oracleFeed = (await dprog.account.wagerProposal.fetch(proposalPda)).oracleFeed;

    await dcprog.methods
      .acceptWager()
      .accounts({
        counterparty: dc.publicKey,
        proposal: proposalPda,
        wager: wagerPda,
        oracleFeed,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    // Proposal should be closed
    const proposalInfo = await connection.getAccountInfo(proposalPda);
    assert.equal(proposalInfo, null, "proposal should be closed after acceptance");

    // Wager should be active
    const wager = await dprog.account.wager.fetch(wagerPda);
    assert.deepStrictEqual(wager.state, { active: {} });
    assert.equal(wager.proposer.toBase58(), dp.publicKey.toBase58());
    assert.equal(wager.counterparty.toBase58(), dc.publicKey.toBase58());
    const bal = await connection.getBalance(wagerPda);
    assert(bal >= 600_000_000, `expected ≥ 0.6 SOL escrowed, got ${bal}`);
    console.log(`     Wager PDA balance: ${(bal / 1e9).toFixed(4)} SOL`);
  });

  await test("cancel_proposal returns stake+rent to proposer", async () => {
    // Create a new proposal to cancel
    const cp = web3.Keypair.generate();
    await airdrop(connection, cp.publicKey, 3_000_000_000);
    const cprog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(cp), {}));
    const [cProposalPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), cp.publicKey.toBuffer()], PROGRAM_ID
    );
    const slotC = await connection.getSlot("confirmed");
    await cprog.methods.proposeWager({
      condition: { priceBelow: {} },
      threshold: new BN("999999999999"), thresholdMin: new BN(0), thresholdMax: new BN(0),
      changePct: 0, snapshotPrice: new BN(0),
      expirySlot: new BN(slotC + 100),
      proposerStake: new BN(200_000_000), counterpartyStake: new BN(200_000_000),
    }).accounts({ proposer: cp.publicKey, proposal: cProposalPda, oracleFeed: CHAINLINK_FEED, systemProgram: web3.SystemProgram.programId }).rpc();

    const balBefore = await connection.getBalance(cp.publicKey);
    await cprog.methods.cancelProposal()
      .accounts({ proposer: cp.publicKey, proposal: cProposalPda, systemProgram: web3.SystemProgram.programId })
      .rpc();

    const pdaAfter = await connection.getAccountInfo(cProposalPda);
    assert.equal(pdaAfter, null, "proposal should be closed after cancel");
    const balAfter = await connection.getBalance(cp.publicKey);
    console.log(`     Returned: ${((balAfter - balBefore) / 1e9).toFixed(4)} SOL`);
    assert(balAfter > balBefore, "proposer should have received lamports back");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  Tests: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
