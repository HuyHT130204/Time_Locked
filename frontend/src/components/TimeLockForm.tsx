"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import type { AccountMeta } from "@solana/web3.js";
import { 
  LAMPORTS_PER_SOL, 
  PublicKey, 
  SystemProgram, 
  Transaction, 
  TransactionInstruction,
  ComputeBudgetProgram 
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getAnchorProgram } from "@/lib/anchorClient";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import dynamic from "next/dynamic";

// Dynamic import to prevent hydration mismatch
const DynamicWalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then(mod => ({ default: mod.WalletMultiButton })),
  { ssr: false }
);

// Constants - đảm bảo seeds khớp với program
const TIME_LOCK_SEED = "time-lock";

interface TimeLockInfo {
  publicKey: PublicKey;
  initializer: PublicKey;
  amount: number;
  unlockTimestamp: number;
  kind: "SOL" | "SPL";
  mint?: PublicKey;
  isExpired: boolean;
}

interface ProgramResult {
  program?: anchor.Program;
  provider?: anchor.AnchorProvider;
  connection?: anchor.web3.Connection;
}

// Type guard for enum checking
function isAssetKind(kind: any): kind is { sol?: {} } | { spl?: {} } {
  return kind && typeof kind === 'object' && (kind.hasOwnProperty('sol') || kind.hasOwnProperty('spl'));
}

export default function TimeLockForm() {
  const { publicKey, connected, wallet, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [amount, setAmount] = useState<string>("");
  const [unlock, setUnlock] = useState<string>("");
  const [asset, setAsset] = useState<"SOL" | "SPL">("SOL");
  const [txSig, setTxSig] = useState<string>("");
  const [lockPda, setLockPda] = useState<PublicKey | null>(null);
  const [lockBump, setLockBump] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [balance, setBalance] = useState<number>(0);
  const [timeLocks, setTimeLocks] = useState<TimeLockInfo[]>([]);
  const [mounted, setMounted] = useState<boolean>(false);
  const [programReady, setProgramReady] = useState<boolean>(false);

  // Use hardcoded USDC mint for devnet
  const usdcMintStr = process.env.NEXT_PUBLIC_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const usdcMint = useMemo(() => new PublicKey(usdcMintStr), [usdcMintStr]);

  // Prevent hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  const { program } = useMemo((): ProgramResult => {
    if (!wallet?.adapter || !connection || !mounted) {
      console.log("Program creation skipped - missing dependencies");
      setProgramReady(false);
      return {} as ProgramResult;
    }

    // Check if wallet is properly connected
    if (!wallet.adapter.publicKey || !wallet.adapter.connected) {
      console.log("Wallet not properly connected");
      setProgramReady(false);
      return {} as ProgramResult;
    }

    try {
      console.log("Creating Anchor program...");
      const result = getAnchorProgram(wallet.adapter, connection);
      
      if (result.program) {
        console.log("Program created successfully, Program ID:", result.program.programId.toString());
        setProgramReady(true);
        setError(""); // Clear any previous errors
        return result;
      } else {
        console.error("Program creation returned no program");
        setProgramReady(false);
        setError("Failed to initialize program");
        return {} as ProgramResult;
      }
    } catch (e) {
      console.error("Error creating program:", e);
      setProgramReady(false);
      setError(`Failed to initialize program: ${e instanceof Error ? e.message : String(e)}`);
      return {} as ProgramResult;
    }
  }, [wallet?.adapter, connection, mounted, wallet?.adapter?.publicKey, wallet?.adapter?.connected]);

  // IDL debug utilities and dynamic account mapper
  const logIdlInfo = useCallback(() => {
    try {
      if (!program?.idl) return;
      // List instruction names
      console.log("IDL instructions:", program.idl.instructions.map(i => i.name));

      const solIx = program.idl.instructions.find(i => i.name?.toLowerCase() === 'initializelocksol');
      const splIx = program.idl.instructions.find(i => i.name?.toLowerCase() === 'initializelockspl');
      const wSolIx = program.idl.instructions.find(i => i.name?.toLowerCase() === 'withdrawsol');
      const wSplIx = program.idl.instructions.find(i => i.name?.toLowerCase() === 'withdrawspl');
      console.log("initializeLockSol accounts:", solIx?.accounts?.map(a => a.name));
      console.log("initializeLockSpl accounts:", splIx?.accounts?.map(a => a.name));
      console.log("withdrawSol accounts:", wSolIx?.accounts?.map(a => a.name));
      console.log("withdrawSpl accounts:", wSplIx?.accounts?.map(a => a.name));
    } catch (e) {
      console.warn("Failed to log IDL info:", e);
    }
  }, [program]);

  useEffect(() => {
    if (program && programReady) {
      logIdlInfo();
    }
  }, [program, programReady, logIdlInfo]);

  type AccountsContext = {
    isSpl: boolean;
    publicKey: PublicKey;
    lockPda: PublicKey;
    usdcMint?: PublicKey;
    userAta?: PublicKey;
    vaultAta?: PublicKey;
  };

  const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const toCamelCase = (name: string) => name.replace(/[_-](\w)/g, (_, c) => c.toUpperCase()).replace(/^(\w)/, (c) => c.toLowerCase());

  const resolveInstruction = useCallback((preferredAlias: string) => {
    if (!program?.idl) throw new Error("Program IDL not available");

    const aliasNorm = normalizeName(preferredAlias);
    const all = program.idl.instructions || [];

    // exact normalized match
    let ix = all.find(i => normalizeName(i.name) === aliasNorm);

    // alias map for common variants
    const aliasMap: Record<string, string[]> = {
      initializeLockSol: ["initialize_lock_sol", "initialize_sol_lock", "init_lock_sol", "initialize_sol"],
      initializeLockSpl: ["initialize_lock_spl", "initialize_spl_lock", "init_lock_spl", "initialize_token", "initialize_usdc"],
      withdrawSol: ["withdraw_sol", "withdrawsol"],
      withdrawSpl: ["withdraw_spl", "withdraw_token", "withdraw_usdc", "withdrawspl"],
    };

    if (!ix) {
      const candidates = aliasMap[preferredAlias] || [];
      ix = all.find(i => candidates.some(a => normalizeName(i.name) === normalizeName(a)));
    }

    // partial contains as last resort
    if (!ix) {
      ix = all.find(i => normalizeName(i.name).includes(aliasNorm));
    }

    if (!ix) throw new Error(`Instruction not found in IDL: ${preferredAlias}`);

    const camel = toCamelCase(ix.name);
    console.log(`Resolved instruction '${preferredAlias}' to IDL '${ix.name}' and method '${camel}'`);
    return { ix, methodName: camel } as const;
  }, [program]);

  const buildAccountsFromIdl = useCallback((instructionAlias: string, ctx: AccountsContext) => {
  if (!program?.idl) throw new Error("Program IDL not available");
  const { ix } = resolveInstruction(instructionAlias);

  const accounts: Record<string, PublicKey> = {};
  const missing: string[] = [];

  const resolve = (name: string): PublicKey | undefined => {
    const n = name.toLowerCase();

    // common authority/user synonyms
    if (["initializer", "authority", "owner", "user", "signer"].includes(n)) return ctx.publicKey;
    // payer mapping
    if (["payer"].includes(n)) return ctx.publicKey;

    // lock account synonyms
    if (["lock_account", "time_lock_account", "lockaccount", "timelockaccount", "locker", "lock"].includes(n)) return ctx.lockPda;

    // system program
    if (["system_program", "systemprogram"].includes(n)) return SystemProgram.programId;

    // sysvar + rent/clock mappings (added to avoid missing-order issues)
    if (["rent", "sysvar_rent"].includes(n)) return anchor.web3.SYSVAR_RENT_PUBKEY;
    if (["clock", "sysvar_clock"].includes(n)) return anchor.web3.SYSVAR_CLOCK_PUBKEY;

    // SPL-specific
    if (!ctx.isSpl) return undefined;
    if (["token_program", "tokenprogram"].includes(n)) return TOKEN_PROGRAM_ID as unknown as PublicKey;
    if (["associated_token_program", "associatedtokenprogram"].includes(n)) return ASSOCIATED_TOKEN_PROGRAM_ID as unknown as PublicKey;
    if (["mint"].includes(n)) return ctx.usdcMint;
    if (["user_token_account", "user_ata", "usertokenaccount", "userata"].includes(n)) return ctx.userAta;
    if (["vault_token_account", "vault_ata", "vaulttokenaccount", "vaultata"].includes(n)) return ctx.vaultAta;

    return undefined;
  };

  for (const a of ix.accounts ?? []) {
    const v = resolve(a.name);
    if (v) accounts[a.name] = v;
    else missing.push(a.name);
  }

  if (missing.length) {
    console.warn(`Missing required accounts for ${ix.name}:`, missing);
    throw new Error(`Missing required accounts: ${missing.join(', ')}`);
  }

  console.log(`Resolved accounts for ${ix.name}:`, accounts);
  return accounts;
}, [program, resolveInstruction]);

  // Simplified transaction sending function to fix wallet errors
  // QUICK FIX: Thay thế sendTransactionSafely function của bạn bằng version này

const sendTransactionSafely = useCallback(async (
  instructionOrTransaction: TransactionInstruction | Transaction, 
  description: string
): Promise<string> => {
  if (!publicKey || !connection || !sendTransaction) {
    throw new Error("Wallet not properly connected");
  }

  console.log(`Starting ${description} transaction...`);

  try {
    // CRITICAL: Validate wallet state trước khi làm gì khác
    if (!wallet?.adapter?.connected) {
      throw new Error("Please reconnect your wallet and try again");
    }

    // Wait a bit để wallet settle nếu vừa connect
    await new Promise(resolve => setTimeout(resolve, 100));

    const isTransaction = instructionOrTransaction instanceof Transaction;
    
    // Get blockhash với strategy đơn giản
    console.log("Getting blockhash...");
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    
    if (!latestBlockhash?.blockhash) {
      throw new Error("Could not get network blockhash");
    }

    // Create transaction
    let transaction;
    if (isTransaction) {
      transaction = instructionOrTransaction;
    } else {
      transaction = new Transaction();
      transaction.add(instructionOrTransaction);
    }
    
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = publicKey;

    // Validate transaction trước khi send
    try {
      transaction.compileMessage();
    } catch (compileError) {
      console.error("Transaction validation failed:", compileError);
      throw new Error("Invalid transaction. Please check your inputs.");
    }

    console.log("Sending transaction with wallet...");
    
    // STRATEGY: Chỉ sử dụng phương pháp đơn giản nhất
    let signature;
    try {
      // Version 1: Minimal options
      signature = await sendTransaction(transaction, connection, {
        skipPreflight: true, // Skip preflight để tránh network issues
        maxRetries: 0 // No retries để tránh conflicts
      });
    } catch (sendError: any) {
      const errorMsg = sendError?.message || String(sendError);
      
      // Check for wallet disconnection
      if (errorMsg.includes("Unexpected error") || 
          errorMsg.includes("WalletSendTransactionError")) {
        throw new Error("WALLET_DISCONNECTED");
      }
      
      // Check for user cancellation
      if (errorMsg.includes("User rejected") || 
          errorMsg.includes("rejected") || 
          errorMsg.includes("cancelled")) {
        throw new Error("Transaction cancelled by user");
      }
      
      throw sendError;
    }

    if (!signature) {
      throw new Error("No transaction signature received");
    }

    console.log("Transaction sent:", signature);
    
    // Simple confirmation - không dùng Promise.race để tránh conflicts
    try {
      console.log("Waiting for confirmation...");
      const confirmation = await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      }, 'processed'); // Sử dụng 'processed' cho confirmation nhanh hơn
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      console.log(`${description} confirmed successfully`);
      return signature;
    } catch (confirmError: any) {
      console.warn("Confirmation may have failed, but transaction was sent:", signature);
      // Return signature anyway để user có thể check manually
      return signature;
    }
    
  } catch (error: any) {
    console.error(`Error in ${description}:`, error);
    const errorMessage = error?.message || String(error);
    
    if (errorMessage === "WALLET_DISCONNECTED") {
      throw new Error("Wallet disconnected unexpectedly. Please:\n• Disconnect your wallet\n• Refresh the page\n• Reconnect and try again");
    }
    
    if (errorMessage.includes("Transaction cancelled")) {
      throw new Error("Transaction was cancelled");
    }
    
    if (errorMessage.includes("insufficient funds")) {
      throw new Error("Insufficient SOL for transaction fees");
    }
    
    if (errorMessage.includes("Please reconnect")) {
      throw new Error(errorMessage);
    }
    
    // Default
    throw new Error(`Transaction failed: ${errorMessage.slice(0, 100)}`);
  }
}, [publicKey, connection, sendTransaction, wallet?.adapter]);

// THÊM: Wallet connection monitor
const [walletError, setWalletError] = useState<string>("");

useEffect(() => {
  if (!wallet?.adapter) return;
  
  const handleError = (error: any) => {
    console.error("Wallet error:", error);
    setWalletError("Wallet connection error. Please reconnect.");
  };
  
  const handleDisconnect = () => {
    console.log("Wallet disconnected");
    setWalletError("");
  };
  
  const handleConnect = () => {
    console.log("Wallet connected");
    setWalletError("");
  };
  
  wallet.adapter.on('error', handleError);
  wallet.adapter.on('disconnect', handleDisconnect);
  wallet.adapter.on('connect', handleConnect);
  
  return () => {
    wallet.adapter.off('error', handleError);
    wallet.adapter.off('disconnect', handleDisconnect);
    wallet.adapter.off('connect', handleConnect);
  };
}, [wallet?.adapter]);

// THÊM: Wallet status indicator trong UI (thêm vào render)
{walletError && (
  <div style={{
    background: "rgba(239, 68, 68, 0.1)",
    border: "1px solid #ef4444",
    borderRadius: "0.5rem",
    padding: "0.75rem",
    color: "#f87171",
    marginBottom: "1rem"
  }}>
    {walletError}
  </div>
)}
  // Helper functions for BN creation and validation
  const createSafeBN = useCallback((value: number, decimals: number = 0): anchor.BN => {
    console.log("createSafeBN input:", { value, decimals, type: typeof value });
    
    if (isNaN(value) || !isFinite(value) || value <= 0) {
      throw new Error(`Invalid number value: ${value}`);
    }
    
    // QUAN TRỌNG: Sử dụng Math.floor để tránh floating point precision issues
    const scaledValue = Math.floor(value * Math.pow(10, decimals));
    console.log("Scaled value:", scaledValue);
    
    if (scaledValue <= 0) {
      throw new Error(`Scaled value must be positive: ${value} * 10^${decimals} = ${scaledValue}`);
    }
    
    // QUAN TRỌNG: Đảm bảo BN được tạo từ string để tránh precision loss
    const bn = new anchor.BN(scaledValue.toString());
    console.log("Created BN:", bn.toString());
    
    // VALIDATION: Kiểm tra BN value
    if (bn.lte(new anchor.BN(0))) {
      throw new Error(`BN must be positive: ${bn.toString()}`);
    }
    
    return bn;
  }, []);


  const createTimestampBN = useCallback((dateString: string): anchor.BN => {
    console.log("createTimestampBN input:", { dateString });
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date string: ${dateString}`);
    }
    
    // QUAN TRỌNG: Đảm bảo timestamp là số nguyên
    const timestamp = Math.floor(date.getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    
    console.log("Timestamp calculation:", { timestamp, now, difference: timestamp - now });
    
    if (timestamp <= now) {
      throw new Error(`Timestamp must be in the future: ${timestamp} <= ${now}`);
    }
    
    // QUAN TRỌNG: Tạo BN từ string
    const bn = new anchor.BN(timestamp.toString());
    console.log("Created timestamp BN:", bn.toString());
    
    if (bn.lte(new anchor.BN(0))) {
      throw new Error(`Invalid timestamp BN: ${bn.toString()}`);
    }
    
    return bn;
  }, []);

  // THÊM: Debug function để test BN creation
  const testBNCreation = () => {
    try {
      const testAmount = 2.0; // 2 SOL
      const testDate = "2025-09-05T13:00"; // Future date
      
      const amountBN = createSafeBN(testAmount, 9);
      const timestampBN = createTimestampBN(testDate);
      
      console.log("Test BN creation:", {
        amountBN: amountBN.toString(),
        timestampBN: timestampBN.toString(),
        amountNumber: amountBN.toNumber(),
        timestampNumber: timestampBN.toNumber()
      });
      
      return { amountBN, timestampBN };
    } catch (e) {
      console.error("BN creation test failed:", e);
      throw e;
    }
  };
  // Cải thiện hàm validateInputs
  const validateInputs = useCallback((amount: string, unlock: string, asset: "SOL" | "SPL", balance: number) => {
    console.log("Validating inputs:", { amount, unlock, asset, balance });
    
    // Validate amount string first
    const trimmedAmount = amount.trim();
    if (!trimmedAmount || trimmedAmount === "") {
      throw new Error("Amount cannot be empty");
    }
    
    // Validate amount parsing
    const amountParsed = parseFloat(trimmedAmount);
    console.log("Amount parsed:", amountParsed);
    
    if (isNaN(amountParsed) || !isFinite(amountParsed)) {
      throw new Error(`Invalid amount format: "${trimmedAmount}". Must be a valid number.`);
    }
    
    if (amountParsed <= 0) {
      throw new Error(`Amount must be positive: ${amountParsed}`);
    }
    
    // Check minimum amounts with more specific thresholds
    if (asset === "SOL") {
      const minSol = 0.000000001; // 1 lamport
      if (amountParsed < minSol) {
        throw new Error(`Amount too small. Minimum is ${minSol} SOL (1 lamport)`);
      }
      
      // Check against balance
      if (amountParsed > balance) {
        throw new Error(`Insufficient balance. Available: ${balance.toFixed(9)} SOL, Requested: ${amountParsed} SOL`);
      }
      
      // Check fee reserve
      const feeReserve = 0.01; // Reserve more for fees
      if ((balance - amountParsed) < feeReserve) {
        throw new Error(`Please leave at least ${feeReserve} SOL for transaction fees. Current balance: ${balance.toFixed(4)} SOL`);
      }
    } else {
      const minUsdc = 0.000001; // Minimum USDC
      if (amountParsed < minUsdc) {
        throw new Error(`Amount too small. Minimum is ${minUsdc} USDC`);
      }
    }
    
    // Validate unlock time string
    if (!unlock || unlock.trim() === "") {
      throw new Error("Unlock time cannot be empty");
    }
    
    // Validate unlock time parsing
    const unlockDate = new Date(unlock);
    console.log("Unlock date parsed:", unlockDate);
    
    if (isNaN(unlockDate.getTime())) {
      throw new Error(`Invalid unlock time format: "${unlock}". Please select a valid date and time.`);
    }
    
    const unlockTs = Math.floor(unlockDate.getTime() / 1000);
    const nowTs = Math.floor(Date.now() / 1000);
    
    console.log("Timestamp validation:", {
      unlockTs,
      nowTs,
      difference: unlockTs - nowTs
    });
    
    if (unlockTs <= nowTs) {
      throw new Error(`Unlock time must be in the future. Selected: ${unlockDate.toLocaleString()}, Current: ${new Date().toLocaleString()}`);
    }
    
    const minFutureSeconds = 60; // At least 1 minute
    if (unlockTs <= nowTs + minFutureSeconds) {
      throw new Error(`Lock time must be at least ${minFutureSeconds} seconds from now. Current difference: ${unlockTs - nowTs} seconds`);
    }
    
    console.log("Input validation successful:", {
      amountParsed,
      unlockTs,
      unlockDate: unlockDate.toLocaleString()
    });
    
    return { amountParsed, unlockTs };
  }, []);

  // FIX 7: Enhanced confirmation function
  const confirmTransactionEnhanced = async (
    connection: anchor.web3.Connection,
    signature: string,
    latestBlockhash: { blockhash: string; lastValidBlockHeight: number },
    description: string
  ): Promise<{ success: boolean; error?: string }> => {
    console.log(`Starting confirmation for ${description}...`);
    
    const maxWaitTime = 60000; // 60 seconds max wait
    const startTime = Date.now();
    let attempt = 0;

    while (Date.now() - startTime < maxWaitTime) {
      attempt++;
      
      try {
        // Method 1: Check if blockhash is still valid
        const currentBlockHeight = await connection.getBlockHeight('confirmed');
        if (currentBlockHeight > latestBlockhash.lastValidBlockHeight) {
          return { 
            success: false, 
            error: "Transaction expired (blockhash no longer valid)" 
          };
        }

        // Method 2: Get signature status
        const status = await connection.getSignatureStatus(signature, {
          searchTransactionHistory: true
        });
        
        if (status?.value) {
          console.log(`${description} status check ${attempt}:`, {
            confirmationStatus: status.value.confirmationStatus,
            slot: status.value.slot,
            err: status.value.err
          });

          if (status.value.err) {
            return { 
              success: false, 
              error: `Transaction failed: ${JSON.stringify(status.value.err)}` 
            };
          }
          
          // Accept both 'confirmed' and 'finalized'
          if (status.value.confirmationStatus === 'confirmed' || 
              status.value.confirmationStatus === 'finalized') {
            console.log(`${description} confirmed with status: ${status.value.confirmationStatus}`);
            return { success: true };
          }
        }

        // Method 3: Use confirmTransaction mỗi 10 attempts
        if (attempt % 5 === 0) {
          try {
            const confirmation = await Promise.race([
              connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
              }, 'confirmed'),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Confirmation timeout')), 10000)
              )
            ]) as any;
            
            if (confirmation.value?.err) {
              return { 
                success: false, 
                error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}` 
              };
            }
            
            if (confirmation.value) {
              console.log(`${description} confirmed via confirmTransaction method`);
              return { success: true };
            }
          } catch (confirmError) {
            console.log(`confirmTransaction attempt ${attempt} failed:`, confirmError);
          }
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (statusError) {
        console.log(`Status check attempt ${attempt} failed:`, statusError);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Final check before giving up
    try {
      console.log("Performing final status check...");
      const finalStatus = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true
      });
      
      if (finalStatus?.value?.confirmationStatus && !finalStatus.value.err) {
        console.log(`${description} succeeded in final check despite timeout`);
        return { success: true };
      }
    } catch (e) {
      console.log("Final status check failed:", e);
    }
    
    return { 
      success: false, 
      error: `Transaction confirmation timeout after ${maxWaitTime/1000} seconds. Check Explorer manually.` 
    };
  };

  // Helper function to format error messages
  const formatErrorMessage = (errorMessage: string): string => {
    const lowerError = errorMessage.toLowerCase();
    
    if (lowerError.includes("user rejected")) {
      return "Transaction was cancelled by user";
    } else if (lowerError.includes("blockhash not found")) {
      return "Network congestion detected. Please try again in a few moments";
    } else if (lowerError.includes("insufficient funds")) {
      return "Insufficient funds for this transaction and fees";
    } else if (lowerError.includes("0x1771") || lowerError.includes("6001")) {
      return "Invalid amount. Amount must be greater than 0";
    } else if (lowerError.includes("0x1772") || lowerError.includes("6002")) {
      return "Unlock time must be in the future";
    } else if (lowerError.includes("0x1") || lowerError.includes("custom program error")) {
      return "Program execution failed. Check input parameters";
    } else if (lowerError.includes("accountnotfound")) {
      return "Required accounts not found. Program may not be properly initialized";
    } else if (lowerError.includes("invalidaccountdata")) {
      return "Invalid account data. Account structure may have changed";
    } else if (lowerError.includes("unexpected error") || lowerError.includes("wallet communication")) {
      return "Wallet communication error. Please disconnect and reconnect your wallet, then try again";
    } else if (lowerError.includes("timeout")) {
      return "Transaction timeout. Please try again with a higher priority fee";
    } else if (lowerError.includes("network")) {
      return "Network error. Please check your connection and try again";
    }
    
    return errorMessage;
  };

  // Thêm function sendTransactionWithKeypair để xử lý transaction với keypair signers
  const sendTransactionWithKeypair = useCallback(async (
    transaction: Transaction,
    signers: anchor.web3.Keypair[],
    description: string
  ): Promise<string> => {
    if (!publicKey || !connection || !sendTransaction) {
      throw new Error("Wallet not properly connected");
    }

    console.log(`Starting ${description} with keypair signers...`);

    try {
      // Validate wallet connection
      if (!wallet?.adapter?.connected || !wallet?.adapter?.publicKey) {
        throw new Error("Wallet disconnected during transaction");
      }

      // Validate transaction
      if (!transaction || !transaction.instructions.length) {
        throw new Error("Invalid transaction provided");
      }

      console.log(`${description} transaction validation passed`, {
        instructionCount: transaction.instructions.length,
        signersCount: signers.length
      });

      // Get fresh blockhash
      console.log("Getting fresh blockhash...");
      let latestBlockhash;
      try {
        latestBlockhash = await connection.getLatestBlockhash('processed');
      } catch (e) {
        console.log("Retrying blockhash request...");
        await new Promise(resolve => setTimeout(resolve, 1000));
        latestBlockhash = await connection.getLatestBlockhash('confirmed');
      }
      
      if (!latestBlockhash?.blockhash) {
        throw new Error("Failed to get valid blockhash");
      }

      console.log("Using blockhash:", latestBlockhash.blockhash.slice(0, 8) + "...");

      // Setup transaction
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = publicKey;

      console.log(`Transaction setup for ${description}:`, {
        blockhash: latestBlockhash.blockhash.slice(0, 8) + "...",
        feePayer: publicKey.toString(),
        instructionCount: transaction.instructions.length,
        signersCount: signers.length
      });

      // Partial sign với keypairs trước
      if (signers.length > 0) {
        console.log("Partially signing with keypairs...");
        transaction.partialSign(...signers);
        console.log("Keypair signing completed");
      }

      // Validate transaction can be compiled
      try {
        const message = transaction.compileMessage();
        console.log("Transaction compilation successful, message length:", message.serialize().length);
      } catch (compileError) {
        console.error("Transaction compilation failed:", compileError);
        throw new Error(`Transaction validation failed: ${compileError}`);
      }

      // Send transaction
      console.log(`Sending ${description} transaction...`);
      let signature;
      
      try {
        signature = await sendTransaction(transaction, connection, {
          skipPreflight: false,
          maxRetries: 1,
        });
        console.log(`${description} transaction sent successfully:`, signature);
      } catch (sendError: any) {
        console.error("Send transaction failed:", sendError);
        
        // Fallback for "Unexpected error"
        if (sendError.message?.includes("Unexpected error") || 
            sendError.message?.includes("WalletSendTransactionError")) {
          console.log("Attempting fallback transaction method...");
          
          try {
            signature = await sendTransaction(transaction, connection);
            console.log(`${description} transaction sent via fallback:`, signature);
          } catch (altError) {
            console.error("Fallback transaction also failed:", altError);
            throw new Error("Transaction failed. Please disconnect and reconnect your wallet, then try again.");
          }
        } else {
          throw sendError;
        }
      }

      // Enhanced confirmation with timeout
      console.log(`Confirming ${description} transaction...`);
      
      try {
        const confirmation = await Promise.race([
          connection.confirmTransaction({
            signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
          }, 'confirmed'),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Confirmation timeout')), 30000)
          )
        ]) as any;
        
        if (confirmation.value?.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        
        console.log(`${description} confirmed successfully`);
        return signature;
        
      } catch (confirmError) {
        console.warn("Confirmation failed but transaction may have succeeded:", confirmError);
        // Return signature for manual verification
        return signature;
      }

    } catch (error: any) {
      console.error(`Error in ${description}:`, error);
      
      const errorMessage = error?.message || String(error);
      
      // Better error handling
      if (errorMessage.includes("User rejected") || 
          errorMessage.includes("user rejected") ||
          errorMessage.includes("User denied")) {
        throw new Error("Transaction was cancelled by user");
      }
      
      if (errorMessage.includes("insufficient funds")) {
        throw new Error("Insufficient funds for transaction and fees");
      }
      
      if (errorMessage.includes("blockhash not found") || 
          errorMessage.includes("BlockhashNotFound")) {
        throw new Error("Network congestion detected. Please try again");
      }

      if (errorMessage.includes("0x1771") || errorMessage.includes("InvalidAmount")) {
        throw new Error("Invalid amount. Amount must be greater than 0");
      }

      if (errorMessage.includes("0x1") || errorMessage.includes("custom program error")) {
        throw new Error("Program execution failed. Check input parameters");
      }

      if (errorMessage.includes("Unexpected error") || 
          errorMessage.includes("WalletSendTransactionError") ||
          errorMessage.includes("wallet communication")) {
        throw new Error("Wallet communication error. Please disconnect and reconnect your wallet, then try again");
      }

      if (errorMessage.includes("Invalid instruction") || 
          errorMessage.includes("Transaction validation failed")) {
        throw new Error("Invalid transaction. Please check your inputs and try again");
      }

      // Default error formatting
      throw new Error(formatErrorMessage(errorMessage));
    }
  }, [publicKey, connection, sendTransaction, wallet?.adapter]);

  // Fetch balance and time locks
  const fetchData = useCallback(async () => {
    if (!publicKey || !connection) return;
    
    try {
      // Fetch SOL balance
      try {
        const solBalance = await connection.getBalance(publicKey);
        setBalance(solBalance / LAMPORTS_PER_SOL);
      } catch (balanceError) {
        console.error("Error fetching balance:", balanceError);
        setBalance(0);
      }
      
      // Fetch time locks if program is ready
      if (program && programReady && lockPda) {
        console.log("Fetching time locks...");
        const locks: TimeLockInfo[] = [];
        
        try {
          console.log("Checking PDA:", lockPda.toString());
          
          // Check if account exists first
          const accountInfo = await connection.getAccountInfo(lockPda);
          if (!accountInfo) {
            console.log("No lock account found");
            setTimeLocks([]);
            return;
          }

          // Try to fetch and decode the account - sử dụng tên account có thể khác
          let lockAccount;
          try {
            // Thử các tên account phổ biến
            lockAccount = await program.account.timeLockAccount.fetch(lockPda);
          } catch {
            try {
              lockAccount = await program.account.lockAccount.fetch(lockPda);
            } catch {
              try {
                lockAccount = await program.account.lock_account.fetch(lockPda);
              } catch {
                console.log("Could not fetch account with any known name");
                return;
              }
            }
          }
          
          console.log("Raw lock account data:", lockAccount);
          
          if (lockAccount) {
            const initializer = lockAccount.initializer as PublicKey;
            const amount = lockAccount.amount as anchor.BN;
            const unlockTimestamp = lockAccount.unlockTimestamp as anchor.BN;
            const kind = lockAccount.kind;
            const mint = lockAccount.mint as PublicKey | null;
            
            console.log("Parsed account data:", {
              initializer: initializer?.toString(),
              amount: amount?.toString(),
              unlockTimestamp: unlockTimestamp?.toString(),
              kind,
              mint: mint?.toString()
            });
            
            // Parse the asset kind more defensively
            let assetKind: "SOL" | "SPL" = "SOL";
            
            if (isAssetKind(kind)) {
              if ('spl' in kind || 'Spl' in kind) {
                assetKind = "SPL";
              } else {
                assetKind = "SOL";
              }
            } else if (typeof kind === 'string') {
              assetKind = kind.toUpperCase() === 'SPL' ? 'SPL' : 'SOL';
            }
            
            const isExpired = Date.now() / 1000 >= unlockTimestamp.toNumber();
            
            locks.push({
              publicKey: lockPda,
              initializer: initializer,
              amount: assetKind === "SOL" ? amount.toNumber() / LAMPORTS_PER_SOL : amount.toNumber(),
              unlockTimestamp: unlockTimestamp.toNumber(),
              kind: assetKind,
              mint: mint || undefined,
              isExpired
            });
          }
        } catch (fetchError) {
          console.log("Error fetching lock account:", fetchError);
          // This is expected if no locks exist yet
        }
        
        setTimeLocks(locks);
        console.log("Time locks updated:", locks);
      }
    } catch (e) {
      console.error("Error in fetchData:", e);
    }
  }, [publicKey, connection, program, programReady, lockPda]);

  useEffect(() => {
    if (mounted) {
      fetchData();
      const interval = setInterval(fetchData, 15000); // Increase interval
      return () => clearInterval(interval);
    }
  }, [fetchData, mounted]);

  useEffect(() => {
    if (!publicKey || !program || !mounted || !programReady) return;
    try {
      // Tính toán PDA và lưu cả bump
      const [pda, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from(TIME_LOCK_SEED), publicKey.toBuffer()],
        program.programId
      );
      setLockPda(pda);
      setLockBump(bump);
      console.log("Lock PDA set:", pda.toString(), "Bump:", bump, "Program ID:", program.programId.toString());
    } catch (e) {
      console.error("Error finding PDA:", e);
      setError("Failed to find program address.");
    }
  }, [publicKey, program, mounted, programReady]);

  const createLock = useCallback(async () => {
    if (!connected || !publicKey || !program || !lockPda || !programReady || lockBump === null) {
      setError("Program not ready. Please wait or reconnect your wallet.");
      return;
    }

    if (!amount || !unlock) {
      setError("Please fill in all fields.");
      return;
    }

    if (loading) {
      console.log("Transaction already in progress, ignoring...");
      return;
    }

    setLoading(true);
    setError("");
    setTxSig("");

    try {
      if (!wallet?.adapter?.connected || !wallet?.adapter?.publicKey) {
        throw new Error("Wallet disconnected. Please reconnect and try again.");
      }

      const { amountParsed, unlockTs } = validateInputs(amount, unlock, asset, balance);

      console.log("Input validation passed:", {
        asset,
        amountParsed,
        unlockTs,
        currentTime: Math.floor(Date.now() / 1000),
        timeDiff: unlockTs - Math.floor(Date.now() / 1000),
        programId: program.programId.toString(),
        lockPda: lockPda.toString(),
        lockBump,
        initializer: publicKey.toString()
      });

      if (asset === "SOL") {
        console.log("Creating SOL lock...");

        // Debug input values trước khi tạo BN
        console.log("Input validation:", {
          amountParsed,
          unlockTs,
          amountString: amount,
          unlockString: unlock
        });

        const amountBN = createSafeBN(amountParsed, 9); // 9 decimals for SOL
        const unlockTsBN = createTimestampBN(unlock);

        // Debug BN values
        console.log("BN creation successful:", {
          amountBN: amountBN.toString(),
          unlockTsBN: unlockTsBN.toString(),
          amountBNNumber: amountBN.toNumber(),
          unlockTsBNNumber: unlockTsBN.toNumber()
        });

        // Validate BN values trước khi gọi program
        if (amountBN.lte(new anchor.BN(0))) {
          throw new Error(`Amount BN is zero or negative: ${amountBN.toString()}`);
        }

        if (unlockTsBN.lte(new anchor.BN(0))) {
          throw new Error(`Unlock timestamp BN is zero or negative: ${unlockTsBN.toString()}`);
        }

        // Tạo instruction với debug
        console.log("Creating initialize instruction...");
        
        const initInstruction = await program.methods
          .initializeLockSol(amountBN, unlockTsBN)
          .accounts({
            initializer: publicKey,
            lock_account: lockPda,
            system_program: SystemProgram.programId,
          })
          .instruction();

        console.log("Init instruction created:", {
          programId: initInstruction.programId.toString(),
          keys: initInstruction.keys.map(k => ({
            pubkey: k.pubkey.toString(),
            isSigner: k.isSigner,
            isWritable: k.isWritable
          })),
          dataLength: initInstruction.data.length
        });

        // Tạo transfer instruction
        const lamportsToTransfer = Math.floor(amountParsed * LAMPORTS_PER_SOL);
        console.log("Transfer amount:", {
          amountParsed,
          lamportsToTransfer,
          LAMPORTS_PER_SOL
        });

        if (lamportsToTransfer <= 0) {
          throw new Error(`Invalid transfer amount: ${lamportsToTransfer}`);
        }

        const transferInstruction = SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: lockPda,
          lamports: lamportsToTransfer
        });

        console.log("Transfer instruction created:", {
          fromPubkey: transferInstruction.keys[0].pubkey.toString(),
          toPubkey: transferInstruction.keys[1].pubkey.toString(),
          lamports: lamportsToTransfer
        });

        // Tạo transaction
        const transaction = new Transaction();
        transaction.add(initInstruction);
        transaction.add(transferInstruction);

        console.log("Transaction created with instructions:", {
          instructionCount: transaction.instructions.length,
          instruction1: "initializeLockSol",
          instruction2: "transfer"
        });

        const signature = await sendTransactionSafely(transaction, "SOL lock creation");
        setTxSig(signature);
      } else {
        console.log("Creating SPL lock...");

        if (!usdcMint) throw new Error("Missing USDC mint configuration");

        const amountBN = createSafeBN(amountParsed, 6); // USDC has 6 decimals
        const unlockTsBN = createTimestampBN(unlock);

        console.log("SPL BN creation successful:", {
          amountBN: amountBN.toString(),
          unlockTsBN: unlockTsBN.toString(),
          amountParsed,
          unlockTs,
          lockBump
        });

        const userAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
        const vaultAta = getAssociatedTokenAddressSync(usdcMint, lockPda, true);

        // Tạo instruction thủ công với đúng account meta
        const instruction = await program.methods
          .initializeLockSpl(amountBN, unlockTsBN)
          .accounts({
            initializer: publicKey,
            lock_account: lockPda,
            mint: usdcMint,
            userAta: userAta,
            vaultAta: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: SystemProgram.programId,
          })
          .instruction();

        console.log("SPL instruction keys:", instruction.keys.map((k: AccountMeta) => ({
          pubkey: k.pubkey.toString(),
          isWritable: k.isWritable,
          isSigner: k.isSigner
        })));

        const signature = await sendTransactionSafely(instruction, "SPL lock creation");
        setTxSig(signature);
      }

      // clear and refresh
      setAmount("");
      setUnlock("");
      setTimeout(() => fetchData(), 8000);

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Error in createLock:", e);
      setError(`Failed to create lock: ${formatErrorMessage(msg)}`);
    } finally {
      setLoading(false);
    }
  }, [asset, amount, connected, lockPda, lockBump, program, publicKey, unlock, usdcMint, fetchData, programReady, balance, loading, sendTransactionSafely, wallet?.adapter, validateInputs, createSafeBN, createTimestampBN]);

  const withdraw = useCallback(async (targetLock?: TimeLockInfo) => {
    if (!connected || !publicKey || !program || !lockPda || !programReady) {
      setError("Program not ready. Please wait or reconnect your wallet.");
      return;
    }
    
    // Prevent multiple simultaneous transactions
    if (loading) {
      console.log("Transaction already in progress, ignoring...");
      return;
    }
    
    setLoading(true);
    setError("");
    setTxSig(""); // Clear previous transaction signature
    
    try {
      // Validate wallet connection before proceeding
      if (!wallet?.adapter?.connected || !wallet?.adapter?.publicKey) {
        throw new Error("Wallet disconnected. Please reconnect and try again.");
      }

      const lockToWithdraw = targetLock || timeLocks.find(lock => lock.isExpired);
      
      if (!lockToWithdraw) {
        throw new Error("No withdrawable lock found");
      }
      
      if (!lockToWithdraw.isExpired) {
        throw new Error("Lock is not yet expired");
      }
      
      console.log("Withdrawing lock:", lockToWithdraw);
      
      if (lockToWithdraw.kind === "SOL") {
        console.log("Withdrawing SOL lock");

        // Tạo instruction thủ công
        const instruction = await program.methods
          .withdrawSol()
          .accounts({
            initializer: publicKey,
            lock_account: lockPda,
            system_program: SystemProgram.programId,
          })
          .instruction();
        
        const signature = await sendTransactionSafely(instruction, "SOL withdrawal");
        setTxSig(signature);
        
      } else {
        if (!usdcMint) throw new Error("Missing USDC mint configuration");

        const userAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
        const vaultAta = getAssociatedTokenAddressSync(usdcMint, lockPda, true);

        console.log("Withdrawing SPL lock");

        // Tạo instruction thủ công
        const instruction = await program.methods
          .withdrawSpl()
          .accounts({
            initializer: publicKey,
            lock_account: lockPda,
            mint: usdcMint,
            userAta: userAta,
            vaultAta: vaultAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction();
        
        const signature = await sendTransactionSafely(instruction, "SPL withdrawal");
        setTxSig(signature);
      }
      
      // Refresh data after successful transaction with delay
      setTimeout(() => fetchData(), 8000);
      
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Error withdrawing:", e);
      setError(`Failed to withdraw: ${formatErrorMessage(msg)}`);
    } finally {
      setLoading(false);
    }
  }, [connected, lockPda, program, publicKey, usdcMint, timeLocks, fetchData, programReady, loading, sendTransactionSafely, wallet?.adapter]);

  const airdropSol = useCallback(async () => {
    if (!publicKey || !connection) return;
    
    // Prevent multiple simultaneous transactions
    if (loading) {
      console.log("Transaction already in progress, ignoring...");
      return;
    }
    
    setLoading(true);
    setError("");
    setTxSig(""); // Clear previous transaction signature
    
    try {
      console.log("Requesting airdrop for:", publicKey.toString());
      const sig = await connection.requestAirdrop(publicKey, 1 * LAMPORTS_PER_SOL);
      console.log("Airdrop signature:", sig);
      
      // Enhanced confirmation for airdrop
      const latestBlockHash = await connection.getLatestBlockhash('finalized');
      const confirmation = await connection.confirmTransaction({
        signature: sig,
        blockhash: latestBlockHash.blockhash,
        lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      }, 'confirmed');
      
      if (confirmation.value.err) {
        throw new Error(`Airdrop failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      setTxSig(sig);
      console.log("Airdrop confirmed successfully");
      
      // Refresh data after successful airdrop with delay
      setTimeout(() => fetchData(), 5000);
      
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Error airdropping:", e);
      
      // Provide more helpful error messages
      if (msg.includes("airdrop")) {
        setError("Airdrop failed. You may have reached the rate limit. Try again later.");
      } else if (msg.includes("rate")) {
        setError("Airdrop rate limit reached. Please wait a few minutes and try again.");
      } else {
        setError(`Airdrop failed: ${formatErrorMessage(msg)}`);
      }
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey, fetchData, loading]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  // Helper function để get minimum datetime for input
  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1); // Minimum 1 minute from now
    return now.toISOString().slice(0, 16);
  };

  // Validation helpers
  const isAmountValid = (amt: string): boolean => {
    const num = parseFloat(amt.trim());
    return !isNaN(num) && isFinite(num) && num > 0;
  };

  const isUnlockTimeValid = (time: string): boolean => {
    const date = new Date(time);
    if (isNaN(date.getTime())) return false;
    const unlockTs = Math.floor(date.getTime() / 1000);
    const nowTs = Math.floor(Date.now() / 1000);
    return unlockTs > nowTs + 60; // At least 1 minute from now
  };

  // Don't render until mounted to prevent hydration mismatch
  if (!mounted) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #111827 0%, #1e40af 50%, #111827 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}>
        <div style={{ color: "white", fontSize: "1.5rem" }}>Loading...</div>
      </div>
    );
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(135deg, #111827 0%, #1e40af 50%, #111827 100%)",
      padding: "1.5rem"
    }}>
      <div style={{
        maxWidth: "72rem",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "2rem"
      }}>
        {/* Header */}
        <div className="glass-effect" style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderRadius: "1rem",
          padding: "1.5rem"
        }}>
          <div>
            <h1 className="gradient-text" style={{
              fontSize: "2.25rem",
              fontWeight: "700"
            }}>
              Time-Locked Wallet
            </h1>
            <p style={{
              color: "#d1d5db",
              marginTop: "0.5rem"
            }}>
              Secure your assets with time-based locks on Solana
            </p>
          </div>
          <DynamicWalletMultiButton className="btn-primary" />
        </div>

        {error && (
          <div style={{
            background: "rgba(127, 29, 29, 0.5)",
            border: "1px solid #ef4444",
            color: "#fecaca",
            padding: "1rem 1.5rem",
            borderRadius: "0.75rem",
            backdropFilter: "blur(4px)"
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem"
            }}>
              <div style={{
                width: "0.5rem",
                height: "0.5rem",
                background: "#f87171",
                borderRadius: "50%",
                animation: "pulse 2s infinite",
                flexShrink: 0
              }}></div>
              <div style={{ wordBreak: "break-word" }}>{error}</div>
            </div>
          </div>
        )}

        {/* Debug Info - Only show in development */}
        {connected && program && process.env.NODE_ENV === 'development' && (
          <div style={{
            background: "rgba(75, 85, 99, 0.3)",
            border: "1px solid #6b7280",
            color: "#d1d5db",
            padding: "1rem 1.5rem",
            borderRadius: "0.75rem",
            backdropFilter: "blur(4px)",
            fontSize: "0.875rem"
          }}>
            <div><strong>Program ID:</strong> {program.programId?.toString() || 'Not loaded'}</div>
            <div><strong>Lock PDA:</strong> {lockPda?.toString() || 'Not calculated'}</div>
            <div><strong>Lock Bump:</strong> {lockBump !== null ? lockBump : 'Not calculated'}</div>
            <div><strong>Wallet:</strong> {publicKey?.toString() || 'Not connected'}</div>
            <div><strong>Program Ready:</strong> {programReady ? 'Yes' : 'No'}</div>
          </div>
        )}

        {/* Program Status */}
        {connected && (
          <div style={{
            background: programReady 
              ? "rgba(22, 163, 74, 0.5)" 
              : "rgba(234, 179, 8, 0.5)",
            border: programReady 
              ? "1px solid #22c55e" 
              : "1px solid #eab308",
            color: programReady 
              ? "#bbf7d0" 
              : "#fde047",
            padding: "1rem 1.5rem",
            borderRadius: "0.75rem",
            backdropFilter: "blur(4px)"
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem"
            }}>
              <div style={{
                width: "0.5rem",
                height: "0.5rem",
                background: programReady ? "#4ade80" : "#facc15",
                borderRadius: "50%",
                animation: "pulse 2s infinite",
                flexShrink: 0
              }}></div>
              {programReady 
                ? "Program ready - You can create time locks" 
                : "Initializing program - Please wait..."}
            </div>
          </div>
        )}

        {connected && (
          <>
            {/* Balance and Actions */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: "1.5rem"
            }}>
              <div className="glass-effect" style={{
                borderRadius: "1rem",
                padding: "1.5rem"
              }}>
                <h3 style={{
                  fontSize: "1.125rem",
                  fontWeight: "600",
                  color: "#d1d5db",
                  marginBottom: "0.5rem"
                }}>
                  Wallet Balance
                </h3>
                <div style={{
                  fontSize: "1.875rem",
                  fontWeight: "700",
                  color: "#60a5fa"
                }}>
                  {balance.toFixed(4)} SOL
                </div>
              </div>
              
              <div className="glass-effect" style={{
                borderRadius: "1rem",
                padding: "1.5rem"
              }}>
                <h3 style={{
                  fontSize: "1.125rem",
                  fontWeight: "600",
                  color: "#d1d5db",
                  marginBottom: "1rem"
                }}>
                  Quick Actions
                </h3>
                <div style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem"
                }}>
                  <button 
                    onClick={airdropSol} 
                    disabled={loading}
                    className="btn-secondary"
                    style={{
                      width: "100%",
                      opacity: loading ? 0.5 : 1
                    }}
                  >
                    {loading ? "Processing..." : "Airdrop 1 SOL"}
                  </button>
                  <a
                    href={process.env.NEXT_PUBLIC_USDC_FAUCET_URL || "https://solfaucet.com/"}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "block",
                      width: "100%",
                      background: "linear-gradient(to right, #db2777, #be185d)",
                      borderRadius: "0.75rem",
                      padding: "0.75rem 1rem",
                      fontWeight: "600",
                      textAlign: "center",
                      textDecoration: "none",
                      color: "white",
                      transition: "all 0.2s"
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "linear-gradient(to right, #be185d, #9d174d)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "linear-gradient(to right, #db2777, #be185d)";
                    }}
                  >
                    Get Devnet USDC
                  </a>
                </div>
              </div>

              <div className="glass-effect" style={{
                borderRadius: "1rem",
                padding: "1.5rem"
              }}>
                <h3 style={{
                  fontSize: "1.125rem",
                  fontWeight: "600",
                  color: "#d1d5db",
                  marginBottom: "0.5rem"
                }}>
                  Active Locks
                </h3>
                <div style={{
                  fontSize: "1.875rem",
                  fontWeight: "700",
                  color: "#a78bfa"
                }}>
                  {timeLocks.length}
                </div>
                <p style={{
                  fontSize: "0.875rem",
                  color: "#9ca3af"
                }}>
                  Time-locked assets
                </p>
              </div>
            </div>

            {/* Create Lock Form */}
            <div className="glass-effect" style={{
              borderRadius: "1rem",
              padding: "1.5rem"
            }}>
              <h3 style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                color: "#d1d5db",
                marginBottom: "1.5rem"
              }}>
                Create New Time Lock
              </h3>
              <div style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: "1rem",
                marginBottom: "1.5rem"
              }}>
                <select 
                  value={asset} 
                  onChange={(e) => setAsset(e.target.value === "SPL" ? "SPL" : "SOL")} 
                  className="input-field"
                  disabled={loading}
                >
                  <option value="SOL">SOL</option>
                  <option value="SPL">USDC (SPL)</option>
                </select>
                <input
                  type="number"
                  step={asset === "SOL" ? "0.0001" : "0.000001"}
                  min={asset === "SOL" ? "0.0001" : "0.000001"}
                  placeholder={asset === "SOL" ? "Amount (SOL)" : "Amount (USDC)"}
                  className="input-field"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={loading}
                />
                <input
                  type="datetime-local"
                  className="input-field"
                  value={unlock}
                  onChange={(e) => setUnlock(e.target.value)}
                  min={getMinDateTime()}
                  disabled={loading}
                />
              </div>
              
              {/* Validation messages */}
              {amount && !isAmountValid(amount) && (
                <div style={{
                  color: "#fbbf24",
                  fontSize: "0.875rem",
                  marginBottom: "0.5rem"
                }}>
                  Please enter a valid positive number
                </div>
              )}
              
              {amount && asset === "SOL" && isAmountValid(amount) && parseFloat(amount) > balance && (
                <div style={{
                  color: "#fbbf24",
                  fontSize: "0.875rem",
                  marginBottom: "0.5rem"
                }}>
                  Insufficient balance. Available: {balance.toFixed(4)} SOL
                </div>
              )}
              
              {amount && asset === "SOL" && isAmountValid(amount) && (balance * LAMPORTS_PER_SOL - parseFloat(amount) * LAMPORTS_PER_SOL < 0.005 * LAMPORTS_PER_SOL) && (
                <div style={{
                  color: "#fbbf24",
                  fontSize: "0.875rem",
                  marginBottom: "0.5rem"
                }}>
                  Please leave at least 0.005 SOL for transaction fees
                </div>
              )}
              
              {unlock && !isUnlockTimeValid(unlock) && (
                <div style={{
                  color: "#fbbf24",
                  fontSize: "0.875rem",
                  marginBottom: "0.5rem"
                }}>
                  Unlock time must be at least 1 minute from now
                </div>
              )}
              
              <button 
                onClick={createLock} 
                disabled={
                  !connected || 
                  loading || 
                  !amount || 
                  !unlock || 
                  !programReady || 
                  !isAmountValid(amount) ||
                  !isUnlockTimeValid(unlock) ||
                  (asset === "SOL" && parseFloat(amount) > balance)
                } 
                className="btn-primary"
                style={{
                  width: "100%",
                  fontSize: "1.125rem",
                  padding: "1rem 1.5rem",
                  opacity: (
                    !connected || 
                    loading || 
                    !amount || 
                    !unlock || 
                    !programReady || 
                    !isAmountValid(amount) ||
                    !isUnlockTimeValid(unlock) ||
                    (asset === "SOL" && parseFloat(amount) > balance)
                  ) ? 0.5 : 1
                }}
              >
                {loading ? "Creating Lock..." : "Create Time Lock"}
              </button>
              
              {!programReady && connected && (
                <p style={{
                  color: "#fbbf24",
                  fontSize: "0.875rem",
                  marginTop: "0.5rem",
                  textAlign: "center"
                }}>
                  Program not ready. Please wait for initialization to complete.
                </p>
              )}
            </div>

            {/* Time Locks List */}
            {timeLocks.length > 0 && (
              <div className="glass-effect" style={{
                borderRadius: "1rem",
                padding: "1.5rem"
              }}>
                <h3 style={{
                  fontSize: "1.25rem",
                  fontWeight: "600",
                  color: "#d1d5db",
                  marginBottom: "1.5rem"
                }}>
                  Your Time Locks
                </h3>
                <div style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem"
                }}>
                  {timeLocks.map((lock, index) => (
                    <div key={index} style={{
                      background: "rgba(31, 41, 55, 0.3)",
                      borderRadius: "0.75rem",
                      padding: "1rem",
                      border: "1px solid #374151"
                    }}>
                      <div style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: "1rem"
                      }}>
                        <div style={{ flex: 1, minWidth: "200px" }}>
                          <div style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.75rem",
                            marginBottom: "0.5rem",
                            flexWrap: "wrap"
                          }}>
                            <span style={{
                              padding: "0.25rem 0.75rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: "600",
                              background: lock.kind === "SOL" ? "rgba(37, 99, 235, 0.2)" : "rgba(147, 51, 234, 0.2)",
                              color: lock.kind === "SOL" ? "#93c5fd" : "#c4b5fd"
                            }}>
                              {lock.kind}
                            </span>
                            <span style={{
                              padding: "0.25rem 0.75rem",
                              borderRadius: "9999px",
                              fontSize: "0.75rem",
                              fontWeight: "600",
                              background: lock.isExpired ? "rgba(22, 163, 74, 0.2)" : "rgba(234, 179, 8, 0.2)",
                              color: lock.isExpired ? "#86efac" : "#fde047"
                            }}>
                              {lock.isExpired ? "Ready to Withdraw" : "Locked"}
                            </span>
                          </div>
                          <div style={{
                            fontSize: "1.125rem",
                            fontWeight: "600",
                            color: "white",
                            marginBottom: "0.25rem"
                          }}>
                            {lock.amount.toFixed(lock.kind === "SOL" ? 4 : 2)} {lock.kind === "SOL" ? "SOL" : "USDC"}
                          </div>
                          <div style={{
                            fontSize: "0.875rem",
                            color: "#9ca3af"
                          }}>
                            Unlocks: {formatDate(lock.unlockTimestamp)}
                          </div>
                          {!lock.isExpired && (
                            <div style={{
                              fontSize: "0.75rem",
                              color: "#fbbf24",
                              marginTop: "0.25rem"
                            }}>
                              Time remaining: {Math.ceil((lock.unlockTimestamp - Date.now() / 1000) / 3600)} hours
                            </div>
                          )}
                        </div>
                        <button
                          onClick={() => withdraw(lock)}
                          disabled={!lock.isExpired || loading}
                          className="btn-secondary"
                          style={{
                            opacity: (!lock.isExpired || loading) ? 0.5 : 1,
                            minWidth: "100px"
                          }}
                        >
                          {loading ? "Processing..." : lock.isExpired ? "Withdraw" : "Locked"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {!connected && (
          <div style={{
            textAlign: "center",
            padding: "5rem 0"
          }}>
            <div style={{
              fontSize: "3.75rem",
              marginBottom: "1.5rem"
            }}>🔒</div>
            <h2 style={{
              fontSize: "1.5rem",
              fontWeight: "600",
              color: "#d1d5db",
              marginBottom: "1rem"
            }}>
              Connect Your Wallet
            </h2>
            <p style={{
              color: "#9ca3af",
              marginBottom: "2rem"
            }}>
              Connect your Solana wallet to start using time-locked wallets
            </p>
            <DynamicWalletMultiButton className="btn-primary" style={{
              padding: "1rem 2rem",
              fontSize: "1.125rem"
            }} />
          </div>
        )}

        {txSig && (
          <div style={{
            background: "rgba(22, 163, 74, 0.5)",
            border: "1px solid #22c55e",
            color: "#bbf7d0",
            padding: "1rem 1.5rem",
            borderRadius: "0.75rem",
            backdropFilter: "blur(4px)"
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              flexWrap: "wrap"
            }}>
              <div style={{
                width: "0.5rem",
                height: "0.5rem",
                background: "#4ade80",
                borderRadius: "50%",
                animation: "pulse 2s infinite",
                flexShrink: 0
              }}></div>
              <div>
                <div>Transaction successful!</div>
                <div style={{ 
                  fontSize: "0.875rem", 
                  opacity: 0.8,
                  wordBreak: "break-all",
                  marginTop: "0.25rem"
                }}>
                  Signature: {txSig}
                </div>
                <a 
                  href={`https://explorer.solana.com/tx/${txSig}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "#4ade80",
                    textDecoration: "underline",
                    fontSize: "0.875rem"
                  }}
                >
                  View on Solana Explorer
                </a>
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .glass-effect {
          background: rgba(31, 41, 55, 0.3);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(75, 85, 99, 0.3);
        }
        
        .gradient-text {
          background: linear-gradient(45deg, #60a5fa, #a78bfa, #f472b6);
          background-clip: text;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-size: 200% 200%;
          animation: gradient-shift 3s ease-in-out infinite;
        }
        
        @keyframes gradient-shift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
        
        .btn-primary {
          background: linear-gradient(45deg, #3b82f6, #8b5cf6);
          border: none;
          border-radius: 0.75rem;
          padding: 0.75rem 1.5rem;
          color: white;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3);
        }
        
        .btn-primary:hover:not(:disabled) {
          background: linear-gradient(45deg, #2563eb, #7c3aed);
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
        }
        
        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .btn-secondary {
          background: linear-gradient(to right, #374151, #4b5563);
          border: 1px solid #6b7280;
          border-radius: 0.5rem;
          padding: 0.5rem 1rem;
          color: white;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .btn-secondary:hover:not(:disabled) {
          background: linear-gradient(to right, #4b5563, #6b7280);
        }
        
        .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .input-field {
          background: rgba(31, 41, 55, 0.5);
          border: 1px solid #374151;
          border-radius: 0.5rem;
          padding: 0.75rem 1rem;
          color: white;
          font-size: 0.875rem;
          transition: border-color 0.2s;
        }
        
        .input-field:focus {
          outline: none;
          border-color: #3b82f6;
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
        }
        
        .input-field:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .input-field::placeholder {
          color: #9ca3af;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        
        /* Wallet button styling */
        :global(.wallet-adapter-button) {
          background: linear-gradient(45deg, #3b82f6, #8b5cf6) !important;
          border: none !important;
          border-radius: 0.75rem !important;
          font-weight: 600 !important;
          transition: all 0.2s !important;
        }
        
        :global(.wallet-adapter-button:hover) {
          background: linear-gradient(45deg, #2563eb, #7c3aed) !important;
          transform: translateY(-2px);
        }
        
        :global(.wallet-adapter-button-trigger) {
          background: linear-gradient(45deg, #3b82f6, #8b5cf6) !important;
        }
        
        /* Responsive design */
        @media (max-width: 768px) {
          .glass-effect {
            padding: 1rem !important;
          }
          
          .gradient-text {
            font-size: 1.875rem !important;
          }
        }
      `}</style>
    </div>
  );
}