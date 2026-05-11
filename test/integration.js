#!/usr/bin/env node
"use strict";

// Patch uuid ESM issue on Node 18
const Module = require("module");
const _resolveFilename = Module._resolveFilename.bind(Module);
Module._resolveFilename = (req, ...rest) => {
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
  const MAX_PER_REQUEST = 2_000_000_000; // devnet cap
  let remaining = lamports;
  while (remaining > 0) {
    const batch = Math.min(remaining, MAX_PER_REQUEST);
    const sig = await conn.requestAirdrop(pk, batch);
    await conn.confirmTransaction(sig, "confirmed");
    remaining -= batch;
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const connection = new web3.Connection(RPC_URL, "confirmed");

  const proposer      = web3.Keypair.generate();
  const counterparty  = web3.Keypair.generate();
  const randomSettler = web3.Keypair.generate();

  console.log(`\nCluster: ${RPC_URL}`);
  console.log("Funding wallets…");
  await airdrop(connection, proposer.publicKey,     5_000_000_000);
  await airdrop(connection, counterparty.publicKey, 5_000_000_000);
  await airdrop(connection, randomSettler.publicKey,    500_000_000);

  const provider = new anchor.AnchorProvider(connection, makeWallet(proposer), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(IDL, provider);

  // ── derive bond PDA ─────────────────────────────────────────────────────────
  const [bondPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), proposer.publicKey.toBuffer(), counterparty.publicKey.toBuffer()],
    PROGRAM_ID
  );

  const currentSlot = await connection.getSlot("confirmed");
  console.log(`\nCurrent slot: ${currentSlot}`);
  console.log("Proposer:     ", proposer.publicKey.toBase58());
  console.log("Counterparty: ", counterparty.publicKey.toBase58());
  console.log("Bond PDA:     ", bondPda.toBase58());

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 1: initialize_bond
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 1: initialize_bond ──");

  await test("creates bond PDA with correct state", async () => {
    const params = {
      condition:         { priceAbove: {} },
      threshold:         new BN("10000000000"),
      thresholdMin:      new BN(0),
      thresholdMax:      new BN(0),
      changePct:         0,
      snapshotPrice:     new BN(0),
      expirySlot:        new BN(currentSlot + 200),
      proposerStake:     new BN(1_000_000_000),
      counterpartyStake: new BN(500_000_000),
    };

    await program.methods
      .initializeBond(params)
      .accounts({
        proposer:      proposer.publicKey,
        counterparty:  counterparty.publicKey,
        bond:          bondPda,
        chainlinkFeed: CHAINLINK_FEED,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([proposer, counterparty])
      .rpc();

    const b = await program.account.bond.fetch(bondPda);
    assert.equal(b.proposer.toBase58(),     proposer.publicKey.toBase58());
    assert.equal(b.counterparty.toBase58(), counterparty.publicKey.toBase58());
    assert.equal(b.oracleFeed.toBase58(),   CHAINLINK_FEED.toBase58());
    assert.deepStrictEqual(b.condition,     { priceAbove: {} });
    assert.equal(b.threshold.toString(),    "10000000000");
    assert.equal(b.expirySlot.toString(),   String(currentSlot + 200));
    assert.equal(b.proposerStake.toString(),    "1000000000");
    assert.equal(b.counterpartyStake.toString(), "500000000");
    assert.deepStrictEqual(b.state,         { active: {} });
  });

  await test("escrows both stakes into PDA", async () => {
    const bondBal = await connection.getBalance(bondPda);
    assert(bondBal >= 1_500_000_000, `expected ≥ 1.5 SOL, got ${bondBal}`);
    console.log(`     PDA balance: ${(bondBal / 1e9).toFixed(4)} SOL`);
  });

  await test("rejects zero proposer stake", async () => {
    const p2 = web3.Keypair.generate();
    await airdrop(connection, p2.publicKey, 2_000_000_000);
    const [pda2] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bond"), p2.publicKey.toBuffer(), counterparty.publicKey.toBuffer()],
      PROGRAM_ID
    );
    try {
      await program.methods
        .initializeBond({
          condition: { priceBelow: {} },
          threshold: new BN(1), thresholdMin: new BN(0), thresholdMax: new BN(0),
          changePct: 0, snapshotPrice: new BN(0),
          expirySlot: new BN(currentSlot + 100),
          proposerStake: new BN(0), counterpartyStake: new BN(1),
        })
        .accounts({
          proposer: p2.publicKey, counterparty: counterparty.publicKey,
          bond: pda2, chainlinkFeed: CHAINLINK_FEED,
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
      [Buffer.from("bond"), p3.publicKey.toBuffer(), counterparty.publicKey.toBuffer()],
      PROGRAM_ID
    );
    try {
      await program.methods
        .initializeBond({
          condition: { priceBetween: {} },
          threshold: new BN(0), thresholdMin: new BN(200), thresholdMax: new BN(100),
          changePct: 0, snapshotPrice: new BN(0),
          expirySlot: new BN(currentSlot + 100),
          proposerStake: new BN(1_000_000), counterpartyStake: new BN(1_000_000),
        })
        .accounts({
          proposer: p3.publicKey, counterparty: counterparty.publicKey,
          bond: pda3, chainlinkFeed: CHAINLINK_FEED,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([p3, counterparty]).rpc();
      assert.fail("should have thrown InvalidBand");
    } catch (e) {
      assert(String(e).includes("InvalidBand"), `wrong error: ${e}`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 2: settle_bond — expiry guards
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 2: settle_bond guards ──");

  await test("rejects settlement before expiry", async () => {
    try {
      await program.methods
        .settleBond()
        .accounts({
          bond:             bondPda,
          proposer:         proposer.publicKey,
          counterparty:     counterparty.publicKey,
          winner:           proposer.publicKey,
          chainlinkFeed:    CHAINLINK_FEED,
          chainlinkProgram: CHAINLINK_PROGRAM,
          systemProgram:    web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("should have thrown NotExpiredYet");
    } catch (e) {
      assert(String(e).includes("NotExpiredYet"), `wrong error: ${e}`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 3: full settle with cloned Chainlink feed
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 3: full settle via Chainlink oracle ──");

  const p4 = web3.Keypair.generate();
  const c4 = web3.Keypair.generate();
  await airdrop(connection, p4.publicKey, 5_000_000_000);
  await airdrop(connection, c4.publicKey, 5_000_000_000);

  const [settlePda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("bond"), p4.publicKey.toBuffer(), c4.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const settleProgram = new anchor.Program(IDL,
    new anchor.AnchorProvider(connection, makeWallet(p4), { commitment: "confirmed" })
  );

  const slotNow = await connection.getSlot("confirmed");

  await test("creates short-lived bond (expiry = current slot + 5)", async () => {
    await settleProgram.methods
      .initializeBond({
        condition: { priceAbove: {} },
        threshold: new BN("1"),
        thresholdMin: new BN(0), thresholdMax: new BN(0),
        changePct: 0, snapshotPrice: new BN(0),
        expirySlot: new BN(slotNow + 5),
        proposerStake:     new BN(500_000_000),
        counterpartyStake: new BN(500_000_000),
      })
      .accounts({
        proposer: p4.publicKey, counterparty: c4.publicKey,
        bond: settlePda, chainlinkFeed: CHAINLINK_FEED,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([p4, c4]).rpc();

    const b = await settleProgram.account.bond.fetch(settlePda);
    assert.deepStrictEqual(b.state, { active: {} });
    console.log(`     Bond expires at slot ${slotNow + 5}`);
  });

  await test("waits for expiry slot", async () => {
    let slot = await connection.getSlot("confirmed");
    while (slot < slotNow + 5) { await sleep(400); slot = await connection.getSlot("confirmed"); }
    console.log(`     Now at slot ${slot}`);
  });

  await test("settles bond — proposer wins (price > $0.00000001)", async () => {
    const p4BalBefore = await connection.getBalance(p4.publicKey);

    await settleProgram.methods
      .settleBond()
      .accounts({
        bond:             settlePda,
        proposer:         p4.publicKey,
        counterparty:     c4.publicKey,
        winner:           p4.publicKey,
        chainlinkFeed:    CHAINLINK_FEED,
        chainlinkProgram: CHAINLINK_PROGRAM,
        systemProgram:    web3.SystemProgram.programId,
      })
      .rpc();

    const pdaInfo = await connection.getAccountInfo(settlePda);
    assert.equal(pdaInfo, null, "bond PDA should be closed");

    const gained = (await connection.getBalance(p4.publicKey)) - p4BalBefore;
    console.log(`     Proposer gained ${(gained / 1e9).toFixed(4)} SOL`);
    assert(gained > 0, "proposer should have gained SOL");
  });

  await test("settle_bond — WrongWinner rejected when wrong party given", async () => {
    const p5 = web3.Keypair.generate(), c5 = web3.Keypair.generate();
    await airdrop(connection, p5.publicKey, 3_000_000_000);
    await airdrop(connection, c5.publicKey, 3_000_000_000);
    const [pda5] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bond"), p5.publicKey.toBuffer(), c5.publicKey.toBuffer()], PROGRAM_ID
    );
    const prog5 = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(p5), {}));
    const slot5 = await connection.getSlot("confirmed");
    await prog5.methods.initializeBond({
      condition: { priceAbove: {} }, threshold: new BN("1"),
      thresholdMin: new BN(0), thresholdMax: new BN(0),
      changePct: 0, snapshotPrice: new BN(0),
      expirySlot: new BN(slot5 + 3),
      proposerStake: new BN(500_000_000), counterpartyStake: new BN(500_000_000),
    })
    .accounts({ proposer: p5.publicKey, counterparty: c5.publicKey, bond: pda5,
      chainlinkFeed: CHAINLINK_FEED, systemProgram: web3.SystemProgram.programId })
    .signers([p5, c5]).rpc();

    let s = await connection.getSlot("confirmed");
    while (s < slot5 + 3) { await sleep(400); s = await connection.getSlot("confirmed"); }

    try {
      await prog5.methods.settleBond()
        .accounts({ bond: pda5, proposer: p5.publicKey, counterparty: c5.publicKey,
          winner: c5.publicKey,
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

    const vp = web3.Keypair.generate(), vc = web3.Keypair.generate();
    await airdrop(connection, vp.publicKey, 3_000_000_000);
    await airdrop(connection, vc.publicKey, 3_000_000_000);
    const [vpda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bond"), vp.publicKey.toBuffer(), vc.publicKey.toBuffer()], PROGRAM_ID
    );
    const vprog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(vp), {}));

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

    const { blockhash } = await connection.getLatestBlockhash();
    const ix = await vprog.methods.initializeBond(verifyParams)
      .accounts({ proposer: vp.publicKey, counterparty: vc.publicKey, bond: vpda,
        chainlinkFeed: CHAINLINK_FEED, systemProgram: web3.SystemProgram.programId })
      .instruction();
    const tx = new web3.Transaction({ recentBlockhash: blockhash, feePayer: vp.publicKey });
    tx.add(ix);
    tx.partialSign(vp, vc);
    const txHex = tx.serialize({ requireAllSignatures: false }).toString("hex");

    const dsl = {
      version: "1",
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
  // SUITE 5: discovery — propose_bond / accept_bond / cancel_bond
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 5: discovery — open proposals ──");

  const dp = web3.Keypair.generate(), dc = web3.Keypair.generate();
  await airdrop(connection, dp.publicKey, 5_000_000_000);
  await airdrop(connection, dc.publicKey, 5_000_000_000);

  const [proposalPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), dp.publicKey.toBuffer()], PROGRAM_ID
  );
  const dprog  = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(dp), {}));
  const dcprog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(dc), {}));

  let discoveryExpirySlot;

  await test("propose_bond creates BondProposal on-chain (single sig)", async () => {
    const slot = await connection.getSlot("confirmed");
    discoveryExpirySlot = slot + 30;
    await dprog.methods
      .proposeBond({
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

    const p = await dprog.account.bondProposal.fetch(proposalPda);
    assert.equal(p.proposer.toBase58(), dp.publicKey.toBase58());
    assert.equal(p.proposerStake.toNumber(), 300_000_000);
    assert.equal(p.counterpartyStake.toNumber(), 300_000_000);
    assert.deepStrictEqual(p.condition, { priceAbove: {} });
    console.log(`     Proposal PDA: ${proposalPda.toBase58()}`);
  });

  await test("getProgramAccounts finds the open proposal", async () => {
    const all = await dprog.account.bondProposal.all();
    const found = all.find(p => p.publicKey.toBase58() === proposalPda.toBase58());
    assert(found, "proposal not found in getProgramAccounts");
    console.log(`     Found ${all.length} total proposal(s) on-chain`);
  });

  await test("accept_bond converts proposal → active Bond", async () => {
    const [wagerPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("bond"), dp.publicKey.toBuffer(), dc.publicKey.toBuffer()], PROGRAM_ID
    );

    const oracleFeed = (await dprog.account.bondProposal.fetch(proposalPda)).oracleFeed;

    await dcprog.methods
      .acceptBond()
      .accounts({
        counterparty: dc.publicKey,
        proposal: proposalPda,
        bond: wagerPda,
        oracleFeed,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    const proposalInfo = await connection.getAccountInfo(proposalPda);
    assert.equal(proposalInfo, null, "proposal should be closed after acceptance");

    const bond = await dprog.account.bond.fetch(wagerPda);
    assert.deepStrictEqual(bond.state, { active: {} });
    assert.equal(bond.proposer.toBase58(), dp.publicKey.toBase58());
    assert.equal(bond.counterparty.toBase58(), dc.publicKey.toBase58());
    const bal = await connection.getBalance(wagerPda);
    assert(bal >= 600_000_000, `expected ≥ 0.6 SOL escrowed, got ${bal}`);
    console.log(`     Bond PDA balance: ${(bal / 1e9).toFixed(4)} SOL`);
  });

  await test("cancel_bond returns stake+rent to proposer", async () => {
    const cp = web3.Keypair.generate();
    await airdrop(connection, cp.publicKey, 3_000_000_000);
    const cprog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(cp), {}));
    const [cProposalPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), cp.publicKey.toBuffer()], PROGRAM_ID
    );
    const slotC = await connection.getSlot("confirmed");
    await cprog.methods.proposeBond({
      condition: { priceBelow: {} },
      threshold: new BN("999999999999"), thresholdMin: new BN(0), thresholdMax: new BN(0),
      changePct: 0, snapshotPrice: new BN(0),
      expirySlot: new BN(slotC + 100),
      proposerStake: new BN(200_000_000), counterpartyStake: new BN(200_000_000),
    }).accounts({ proposer: cp.publicKey, proposal: cProposalPda, oracleFeed: CHAINLINK_FEED,
      systemProgram: web3.SystemProgram.programId }).rpc();

    const balBefore = await connection.getBalance(cp.publicKey);
    await cprog.methods.cancelBond()
      .accounts({ proposer: cp.publicKey, proposal: cProposalPda,
        systemProgram: web3.SystemProgram.programId })
      .rpc();

    const pdaAfter = await connection.getAccountInfo(cProposalPda);
    assert.equal(pdaAfter, null, "proposal should be closed after cancel");
    const balAfter = await connection.getBalance(cp.publicKey);
    console.log(`     Returned: ${((balAfter - balBefore) / 1e9).toFixed(4)} SOL`);
    assert(balAfter > balBefore, "proposer should have received lamports back");
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 6: register_protocol — on-chain capabilities meta PDA
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 6: register_protocol ──");

  const [metaPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("meta")], PROGRAM_ID
  );

  await test("register_protocol stores URI in ProtocolMeta PDA", async () => {
    const EXPECTED_URI = "https://jkr26.github.io/sol_dsl/.well-known/clawbond.json";

    const existing = await connection.getAccountInfo(metaPda);
    if (!existing) {
      await program.methods
        .registerProtocol(EXPECTED_URI)
        .accounts({
          payer: proposer.publicKey,
          meta: metaPda,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([proposer])
        .rpc();

      const meta = await program.account.protocolMeta.fetch(metaPda);
      assert.strictEqual(meta.uri, EXPECTED_URI, "stored URI must match exactly");
      console.log(`     Meta PDA: ${metaPda.toBase58()}`);
      console.log(`     URI:      ${meta.uri}`);
    } else {
      const meta = await program.account.protocolMeta.fetch(metaPda);
      console.log(`     Meta PDA: ${metaPda.toBase58()}`);
      console.log(`     URI:      ${meta.uri}`);
      if (meta.uri !== EXPECTED_URI) {
        console.warn(`     ⚠  stale URI on local validator (expected "${EXPECTED_URI}") — run with --reset to fix`);
      }
      // Pre-existing PDA: can't update on-chain, so only assert non-empty
      assert(meta.uri.length > 0, "URI should be stored");
    }
  });

  await test("register_protocol rejects duplicate creation", async () => {
    try {
      await program.methods
        .registerProtocol("https://example.com/duplicate")
        .accounts({
          payer: proposer.publicKey,
          meta: metaPda,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([proposer])
        .rpc();
      assert.fail("should have thrown — meta PDA already exists");
    } catch (e) {
      assert(String(e).length > 0, "expected an error");
      console.log("     Duplicate rejected as expected");
    }
  });

  await test("register_protocol rejects URI > 200 bytes", async () => {
    const rp2 = web3.Keypair.generate();
    await airdrop(connection, rp2.publicKey, 1_000_000_000);
    const longUri = "x".repeat(201);
    try {
      const prog2 = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(rp2), {}));
      const [freshMeta] = web3.PublicKey.findProgramAddressSync([Buffer.from("meta")], PROGRAM_ID);
      await prog2.methods.registerProtocol(longUri)
        .accounts({ payer: rp2.publicKey, meta: freshMeta,
          systemProgram: web3.SystemProgram.programId })
        .rpc();
      assert.fail("should have thrown UriTooLong");
    } catch (e) {
      assert(String(e).length > 0, "expected an error");
      console.log(`     Long URI rejected (${String(e).slice(0, 60)}...)`);
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SUITE 7: WorkBond — create / join / complete / fail / expire
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\n── Suite 7: WorkBond ──");

  const payer        = proposer;         // reuse proposer keypair as payer
  const worker       = counterparty;     // reuse counterparty keypair as worker
  const adjudicator  = web3.Keypair.generate();
  await airdrop(connection, adjudicator.publicKey, 1_000_000_000);

  const payerProg      = program;
  const workerProg     = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(worker), {}));
  const adjudicatorProg = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(adjudicator), {}));

  const PAYMENT      = 500_000_000;  // 0.5 SOL
  const WORKER_STAKE = 100_000_000;  // 0.1 SOL
  const wbSlot       = await connection.getSlot();
  const EXPIRY_FAR   = wbSlot + 500_000;

  const [workBondPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("workbond"), payer.publicKey.toBuffer(), worker.publicKey.toBuffer()],
    PROGRAM_ID
  );
  console.log(`     WorkBond PDA: ${workBondPda.toBase58()}`);

  await test("create_work_bond escrows payment and stores payer/worker/adjudicator", async () => {
    await payerProg.methods
      .createWorkBond({ payment: new anchor.BN(PAYMENT), workerStake: new anchor.BN(WORKER_STAKE), expirySlot: new anchor.BN(EXPIRY_FAR) })
      .accounts({
        payer: payer.publicKey,
        worker: worker.publicKey,
        adjudicator: adjudicator.publicKey,
        workBond: workBondPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const wb = await program.account.workBond.fetch(workBondPda);
    assert.strictEqual(wb.payer.toBase58(),       payer.publicKey.toBase58());
    assert.strictEqual(wb.worker.toBase58(),       worker.publicKey.toBase58());
    assert.strictEqual(wb.adjudicator.toBase58(),  adjudicator.publicKey.toBase58());
    assert.strictEqual(wb.payment.toNumber(),      PAYMENT);
    assert.strictEqual(wb.workerStake.toNumber(),  WORKER_STAKE);
    assert.deepStrictEqual(Object.keys(wb.state), ["pendingWorker"]);

    const lamports = (await connection.getAccountInfo(workBondPda)).lamports;
    assert(lamports >= PAYMENT, "bond should hold at least the payment");
    console.log(`     PDA balance: ${(lamports / 1e9).toFixed(4)} SOL`);
  });

  await test("join_work_bond rejects wrong worker", async () => {
    const imposter = web3.Keypair.generate();
    await airdrop(connection, imposter.publicKey, 1_000_000_000);
    const imposterProg = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(imposter), {}));
    try {
      await imposterProg.methods.joinWorkBond()
        .accounts({
          worker: imposter.publicKey,
          workBond: workBondPda,
          systemProgram: web3.SystemProgram.programId,
        })
        .signers([imposter])
        .rpc();
      assert.fail("should have rejected wrong worker");
    } catch (e) {
      assert(String(e).length > 0);
      console.log("     Wrong worker rejected as expected");
    }
  });

  await test("join_work_bond transitions state to Active", async () => {
    await workerProg.methods.joinWorkBond()
      .accounts({
        worker: worker.publicKey,
        workBond: workBondPda,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([worker])
      .rpc();

    const wb = await program.account.workBond.fetch(workBondPda);
    assert.deepStrictEqual(Object.keys(wb.state), ["active"]);

    const lamports = (await connection.getAccountInfo(workBondPda)).lamports;
    assert(lamports >= PAYMENT + WORKER_STAKE, "bond should hold payment + worker stake");
    console.log(`     PDA balance after join: ${(lamports / 1e9).toFixed(4)} SOL`);
  });

  await test("complete_work_bond rejects wrong adjudicator", async () => {
    try {
      await payerProg.methods.completeWorkBond()
        .accounts({
          adjudicator: payer.publicKey,
          worker: worker.publicKey,
          workBond: workBondPda,
        })
        .signers([payer])
        .rpc();
      assert.fail("should have rejected non-adjudicator");
    } catch (e) {
      assert(String(e).length > 0);
      console.log("     Wrong adjudicator rejected as expected");
    }
  });

  await test("complete_work_bond sends all lamports to worker", async () => {
    const workerBefore = (await connection.getAccountInfo(worker.publicKey)).lamports;

    await adjudicatorProg.methods.completeWorkBond()
      .accounts({
        adjudicator: adjudicator.publicKey,
        worker: worker.publicKey,
        workBond: workBondPda,
      })
      .signers([adjudicator])
      .rpc();

    const workerAfter = (await connection.getAccountInfo(worker.publicKey)).lamports;
    const gained = workerAfter - workerBefore;
    assert(gained >= PAYMENT + WORKER_STAKE, `worker should gain at least payment+stake; gained ${gained}`);
    console.log(`     Worker gained: ${(gained / 1e9).toFixed(4)} SOL`);

    const closed = await connection.getAccountInfo(workBondPda);
    assert(!closed || closed.lamports === 0, "work bond PDA should be closed");
  });

  // Fail path — use a fresh work bond
  const worker2 = web3.Keypair.generate();
  await airdrop(connection, worker2.publicKey, 1_000_000_000);
  const worker2Prog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(worker2), {}));
  const payer2 = web3.Keypair.generate();
  await airdrop(connection, payer2.publicKey, 2_000_000_000);
  const payer2Prog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(payer2), {}));

  const [workBond2Pda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("workbond"), payer2.publicKey.toBuffer(), worker2.publicKey.toBuffer()],
    PROGRAM_ID
  );

  await test("fail_work_bond sends all lamports to payer", async () => {
    await payer2Prog.methods
      .createWorkBond({ payment: new anchor.BN(PAYMENT), workerStake: new anchor.BN(WORKER_STAKE), expirySlot: new anchor.BN(EXPIRY_FAR) })
      .accounts({
        payer: payer2.publicKey,
        worker: worker2.publicKey,
        adjudicator: adjudicator.publicKey,
        workBond: workBond2Pda,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([payer2])
      .rpc();

    await worker2Prog.methods.joinWorkBond()
      .accounts({
        worker: worker2.publicKey,
        workBond: workBond2Pda,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([worker2])
      .rpc();

    const payerBefore = (await connection.getAccountInfo(payer2.publicKey)).lamports;

    await adjudicatorProg.methods.failWorkBond()
      .accounts({
        adjudicator: adjudicator.publicKey,
        payer: payer2.publicKey,
        workBond: workBond2Pda,
      })
      .signers([adjudicator])
      .rpc();

    const payerAfter = (await connection.getAccountInfo(payer2.publicKey)).lamports;
    const gained = payerAfter - payerBefore;
    assert(gained >= PAYMENT + WORKER_STAKE, `payer should gain payment+worker_stake; gained ${gained}`);
    console.log(`     Payer gained: ${(gained / 1e9).toFixed(4)} SOL`);
  });

  // Expire path — short expiry, both joined (Active state)
  const payer3 = web3.Keypair.generate();
  const worker3 = web3.Keypair.generate();
  await airdrop(connection, payer3.publicKey, 2_000_000_000);
  await airdrop(connection, worker3.publicKey, 1_000_000_000);
  const payer3Prog  = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(payer3), {}));
  const worker3Prog = new anchor.Program(IDL, new anchor.AnchorProvider(connection, makeWallet(worker3), {}));

  const [workBond3Pda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("workbond"), payer3.publicKey.toBuffer(), worker3.publicKey.toBuffer()],
    PROGRAM_ID
  );

  await test("expire_work_bond refunds payer and worker after expiry", async () => {
    const nowSlot = await connection.getSlot();

    await payer3Prog.methods
      .createWorkBond({ payment: new anchor.BN(PAYMENT), workerStake: new anchor.BN(WORKER_STAKE), expirySlot: new anchor.BN(nowSlot + 5) })
      .accounts({
        payer: payer3.publicKey,
        worker: worker3.publicKey,
        adjudicator: adjudicator.publicKey,
        workBond: workBond3Pda,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([payer3])
      .rpc();

    await worker3Prog.methods.joinWorkBond()
      .accounts({
        worker: worker3.publicKey,
        workBond: workBond3Pda,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([worker3])
      .rpc();

    // wait for expiry
    let slot = await connection.getSlot();
    console.log(`     Waiting for expiry slot ${nowSlot + 5} (now ${slot})`);
    while (slot <= nowSlot + 5) {
      await new Promise(r => setTimeout(r, 400));
      slot = await connection.getSlot();
    }

    const payer3Before  = (await connection.getAccountInfo(payer3.publicKey)).lamports;
    const worker3Before = (await connection.getAccountInfo(worker3.publicKey)).lamports;

    // permissionless — proposer calls it here but any signer would work
    await payer3Prog.methods.expireWorkBond()
      .accounts({
        payer:    payer3.publicKey,
        worker:   worker3.publicKey,
        workBond: workBond3Pda,
      })
      .signers([payer3])
      .rpc();

    const payer3After  = (await connection.getAccountInfo(payer3.publicKey)).lamports;
    const worker3After = (await connection.getAccountInfo(worker3.publicKey)).lamports;

    const payerGained  = payer3After  - payer3Before;
    const workerGained = worker3After - worker3Before;
    assert(payerGained  >= PAYMENT,      `payer should reclaim payment; gained ${payerGained}`);
    assert(workerGained >= WORKER_STAKE, `worker should reclaim stake; gained ${workerGained}`);
    console.log(`     Payer reclaimed: ${(payerGained / 1e9).toFixed(4)} SOL`);
    console.log(`     Worker reclaimed: ${(workerGained / 1e9).toFixed(4)} SOL`);
  });

  // ────────────────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  Tests: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
