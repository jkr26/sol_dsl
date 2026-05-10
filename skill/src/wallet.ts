import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs";

export interface WalletAdapter {
  publicKey: import("@solana/web3.js").PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  payer: Keypair;
}

/**
 * Loads a Solana keypair from a JSON file (array-of-numbers format,
 * matching the standard `solana-keygen` output).
 */
export function loadWallet(walletPath: string): WalletAdapter {
  const raw = fs.readFileSync(walletPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(raw) as number[]);
  const keypair = Keypair.fromSecretKey(secretKey);

  return {
    publicKey: keypair.publicKey,
    payer: keypair,

    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof Transaction) {
        tx.sign(keypair);
      } else {
        (tx as VersionedTransaction).sign([keypair]);
      }
      return tx;
    },

    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      return txs.map((tx) => {
        if (tx instanceof Transaction) tx.sign(keypair);
        else (tx as VersionedTransaction).sign([keypair]);
        return tx;
      });
    },
  };
}
