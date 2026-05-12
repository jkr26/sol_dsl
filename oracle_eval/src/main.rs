/// ClawBond oracle evaluation function — runs inside a Switchboard TEE (Intel SGX).
///
/// This binary is deployed to Switchboard's oracle network as a FunctionAccountData.
/// When triggered by request_oracle_evaluation on-chain, Switchboard runs this binary
/// in an SGX enclave, it fetches real-world data, evaluates the completion condition,
/// and submits a signed oracle_callback transaction back to the clawbond program.
///
/// Deployment:
///   1. Build for x86_64-unknown-linux-musl (Switchboard's container target)
///   2. docker build -t oracle_eval .
///   3. switchboard-cli function deploy oracle_eval --network devnet
///   4. Note the FunctionAccountData pubkey — this is sb_function in oracle_work_bond_create
use std::str::FromStr;

use anchor_lang::InstructionData;
use serde::{Deserialize, Serialize};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};
use switchboard_utils::runner::FunctionRunner;

// ---------------------------------------------------------------------------
// Evaluation params — committed as SHA-256 hash at bond creation
// ---------------------------------------------------------------------------

/// Top-level params envelope. Passed as JSON bytes to the Switchboard function.
/// The oracle_work_bond field tells the function which account to call back into.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "template", rename_all = "snake_case")]
pub enum EvalParams {
    /// "PR #N on owner/repo is merged" — resolves to 1 when merged, 0 otherwise.
    GithubPrMerged {
        oracle_work_bond: String,
        payer:            String,
        worker:           String,
        repo:             String,   // "owner/repo"
        pr_number:        u64,
    },
    /// Generic HTTP GET: fetch url, extract json_path, compare to expected.
    /// json_path uses dot-notation: "data.status" → body["data"]["status"]
    HttpGet {
        oracle_work_bond: String,
        payer:            String,
        worker:           String,
        url:              String,
        json_path:        String,  // dot-separated field path into response body
        expected:         String,  // exact string the field must equal for result=1
    },
    /// Verify a Solana transaction was confirmed — useful for cross-program work.
    SolanaTxConfirmed {
        oracle_work_bond: String,
        payer:            String,
        worker:           String,
        rpc_url:          String,
        tx_signature:     String,
    },
    /// Check that an IPFS CID is pinned and optionally matches an expected SHA-256.
    IpfsCidExists {
        oracle_work_bond: String,
        payer:            String,
        worker:           String,
        cid:              String,
        expected_sha256:  Option<String>,
    },
}

impl EvalParams {
    fn oracle_work_bond(&self) -> &str {
        match self {
            Self::GithubPrMerged   { oracle_work_bond, .. } => oracle_work_bond,
            Self::HttpGet          { oracle_work_bond, .. } => oracle_work_bond,
            Self::SolanaTxConfirmed { oracle_work_bond, .. } => oracle_work_bond,
            Self::IpfsCidExists    { oracle_work_bond, .. } => oracle_work_bond,
        }
    }
    fn payer(&self) -> &str {
        match self {
            Self::GithubPrMerged   { payer, .. } => payer,
            Self::HttpGet          { payer, .. } => payer,
            Self::SolanaTxConfirmed { payer, .. } => payer,
            Self::IpfsCidExists    { payer, .. } => payer,
        }
    }
    fn worker(&self) -> &str {
        match self {
            Self::GithubPrMerged   { worker, .. } => worker,
            Self::HttpGet          { worker, .. } => worker,
            Self::SolanaTxConfirmed { worker, .. } => worker,
            Self::IpfsCidExists    { worker, .. } => worker,
        }
    }
}

// ---------------------------------------------------------------------------
// Evaluation logic
// ---------------------------------------------------------------------------

async fn evaluate(params: &EvalParams) -> anyhow::Result<u8> {
    match params {
        EvalParams::GithubPrMerged { repo, pr_number, .. } => {
            let url = format!(
                "https://api.github.com/repos/{}/pulls/{}",
                repo, pr_number
            );
            let client = reqwest::Client::builder()
                .user_agent("clawbond-oracle/0.1")
                .build()?;
            let resp: serde_json::Value = client.get(&url).send().await?.json().await?;
            let merged = resp["merged"].as_bool().unwrap_or(false);
            Ok(merged as u8)
        }

        EvalParams::HttpGet { url, json_path, expected, .. } => {
            let resp: serde_json::Value =
                reqwest::get(url).await?.json().await?;
            let value = resolve_json_path(&resp, json_path);
            let matches = value.as_str() == Some(expected.as_str())
                || value.to_string().trim_matches('"') == expected.as_str();
            Ok(matches as u8)
        }

        EvalParams::SolanaTxConfirmed { rpc_url, tx_signature, .. } => {
            let url = format!("{}", rpc_url);
            let body = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getTransaction",
                "params": [tx_signature, { "commitment": "confirmed" }]
            });
            let resp: serde_json::Value =
                reqwest::Client::new().post(&url).json(&body).send().await?.json().await?;
            let confirmed = !resp["result"].is_null();
            Ok(confirmed as u8)
        }

        EvalParams::IpfsCidExists { cid, expected_sha256, .. } => {
            let url = format!("https://ipfs.io/ipfs/{}", cid);
            let resp = reqwest::get(&url).await?;
            if !resp.status().is_success() {
                return Ok(0);
            }
            if let Some(expected) = expected_sha256 {
                use sha2::{Digest, Sha256};
                let bytes = resp.bytes().await?;
                let hash = format!("{:x}", Sha256::digest(&bytes));
                Ok((hash == *expected) as u8)
            } else {
                Ok(1)
            }
        }
    }
}

/// Resolve a dot-separated JSON path: "data.status" → body["data"]["status"]
fn resolve_json_path<'a>(value: &'a serde_json::Value, path: &str) -> &'a serde_json::Value {
    let mut current = value;
    for key in path.split('.') {
        current = &current[key];
    }
    current
}

// ---------------------------------------------------------------------------
// Switchboard entrypoint
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let runner = FunctionRunner::new_from_cluster(
        switchboard_utils::Cluster::Devnet,
        None,
    ).await?;

    // Params bytes are passed by the Switchboard runtime.
    let params_bytes = runner.params().to_vec();
    let params: EvalParams = serde_json::from_slice(&params_bytes)
        .map_err(|e| anyhow::anyhow!("Invalid params JSON: {}", e))?;

    let result = evaluate(&params).await.unwrap_or(0);

    // Build the oracle_callback instruction for the clawbond program.
    let clawbond_id = Pubkey::from_str("GJYEW4jBbBZTVNTdG2AB3EHjC39hFuWWZjaxvDUpmZ3i")?;
    let oracle_work_bond = Pubkey::from_str(params.oracle_work_bond())?;
    let payer_key        = Pubkey::from_str(params.payer())?;
    let worker_key       = Pubkey::from_str(params.worker())?;

    // Discriminator for oracle_callback instruction (first 8 bytes of sha256("global:oracle_callback"))
    let discriminator = anchor_lang::solana_program::hash::hash(
        b"global:oracle_callback"
    ).to_bytes()[..8].to_vec();

    let mut data = discriminator;
    data.push(result);

    let callback_ix = Instruction {
        program_id: clawbond_id,
        accounts: vec![
            AccountMeta::new_readonly(runner.enclave_signer, true), // enclave_signer
            AccountMeta::new_readonly(runner.function_request,  false), // function_request
            AccountMeta::new(oracle_work_bond, false),               // oracle_work_bond
            AccountMeta::new(payer_key,  false),                     // payer
            AccountMeta::new(worker_key, false),                     // worker
        ],
        data,
    };

    runner.emit(vec![callback_ix]).await?;
    Ok(())
}
