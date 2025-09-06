"use client";
import BN from "bn.js";
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
import Image from "next/image";
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

// ✅ CRITICAL: Component đếm ngược thời gian real-time
const TimeRemaining = ({ unlockTimestamp }: { unlockTimestamp: number }) => {
  const [timeRemaining, setTimeRemaining] = useState<string>("");

  useEffect(() => {
    const updateTimeRemaining = () => {
      const now = Math.floor(Date.now() / 1000);
      const remaining = unlockTimestamp - now;
      
      if (remaining <= 0) {
        setTimeRemaining("Ready to withdraw!");
        return;
      }
      
      const days = Math.floor(remaining / (24 * 3600));
      const hours = Math.floor((remaining % (24 * 3600)) / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      const seconds = remaining % 60;
      
      let timeString = "";
      if (days > 0) timeString += `${days}d `;
      if (hours > 0) timeString += `${hours}h `;
      if (minutes > 0) timeString += `${minutes}m `;
      if (seconds > 0) timeString += `${seconds}s`;
      
      setTimeRemaining(timeString.trim());
    };

    // Update immediately
    updateTimeRemaining();
    
    // Update every second
    const interval = setInterval(updateTimeRemaining, 1000);
    
    return () => clearInterval(interval);
  }, [unlockTimestamp]);

  return (
    <div style={{
      fontSize: "0.75rem",
      color: "#fbbf24",
      marginTop: "0.25rem",
      fontWeight: "500"
    }}>
      Time remaining: {timeRemaining}
    </div>
  );
};

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
  const [walletError, setWalletError] = useState<string>("");

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
        setError("");
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

  // IDL debug utilities
  const logIdlInfo = useCallback(() => {
    try {
      if (!program?.idl) return;
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

  // Wallet connection monitor
  useEffect(() => {
    if (!wallet?.adapter) return;
    
    const handleError = (error: any) => {
      console.error("Wallet error:", error);
      const errorMessage = error?.message || String(error);
      
      // Don't show wallet connection error for user cancellations
      if (errorMessage.includes("User rejected") || 
          errorMessage.includes("Transaction cancelled") ||
          errorMessage.includes("cancelled")) {
        console.log("User cancelled transaction, not showing wallet error");
        return;
      }
      
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

  // ✅ CRITICAL FIX: BN creation với proper serialization cho Anchor
  const createSafeBN = useCallback((value: number, decimals: number = 0): BN => {
    console.log("createSafeBN input:", { value, decimals, type: typeof value });
    
    if (isNaN(value) || !isFinite(value) || value <= 0) {
      throw new Error(`Invalid number value: ${value}`);
    }
    
    // ✅ CRITICAL FIX: Chuyển đổi chính xác cho Anchor
    let scaledValue: number;
    if (decimals > 0) {
      // Sử dụng string multiplication để tránh floating point errors
      const multiplier = Math.pow(10, decimals);
      scaledValue = Math.floor(value * multiplier);
    } else {
      scaledValue = Math.floor(value);
    }
    
    console.log("BN creation steps:", {
      originalValue: value,
      decimals,
      scaledValue,
      scaledValueType: typeof scaledValue
    });
    
    // ✅ CRITICAL: Tạo BN từ string để đảm bảo precision
    // NHƯNG QUAN TRỌNG: Phải dùng constructor đúng cách
    const bn = new BN(scaledValue.toString(), 10); // Explicit base 10
    
    // Final validation
    if (bn.lte(new BN(0))) {
      throw new Error(`BN must be positive: input=${value}, decimals=${decimals}, result=${bn.toString()}`);
    }
    
    console.log("Created BN successfully:", {
      input: value,
      decimals,
      result: bn.toString(),
      hex: bn.toString(16),
      // ✅ FIX: Dùng toArrayLike thay vì toArray
      bytesLittleEndian: bn.toArrayLike(Buffer, 'le', 8),
      backToNumber: bn.toNumber() / Math.pow(10, decimals)
    });
    
    return bn;
  }, []);

  const createTimestampBN = useCallback((dateString: string): BN => {
    console.log("createTimestampBN input:", { dateString });
    
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date string: ${dateString}`);
    }
    
    // Convert to Unix timestamp (seconds)
    const timestamp = Math.floor(date.getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    
    console.log("Timestamp calculation:", { 
      timestamp, 
      now, 
      difference: timestamp - now,
      dateString,
      parsedDate: date.toISOString()
    });
    
    if (timestamp <= now) {
      throw new Error(`Timestamp must be in the future: ${timestamp} <= ${now}`);
    }
    
    // ✅ CRITICAL: Kiểm tra thời gian tối thiểu là 5 phút (300 giây)
    const minTimeInSeconds = 5 * 60; // 5 phút
    const timeDifference = timestamp - now;
    if (timeDifference < minTimeInSeconds) {
      throw new Error(`Minimum lock time is 5 minutes. You selected ${Math.floor(timeDifference / 60)} minutes.`);
    }
    
    // ✅ CRITICAL: Tạo BN từ string cho timestamp với base 10 explicit
    const bn = new BN(timestamp.toString(), 10);
    
    // Validation
    if (bn.lte(new BN(0))) {
      throw new Error(`Invalid timestamp BN: ${bn.toString()}`);
    }
    
    console.log("Created timestamp BN:", {
      input: dateString,
      timestamp,
      result: bn.toString(),
      hex: bn.toString(16),
      // ✅ FIX: Dùng toArrayLike với Buffer
      bytesLittleEndian: bn.toArrayLike(Buffer, 'le', 8),
      backToNumber: bn.toNumber(),
      futureDate: new Date(bn.toNumber() * 1000).toLocaleString()
    });
    
    return bn;
  }, []);

  // Enhanced transaction sending function
  const sendTransactionSafely = useCallback(async (
    instructionOrTransaction: TransactionInstruction | Transaction, 
    description: string
  ): Promise<string> => {
    if (!publicKey || !connection || !sendTransaction) {
      throw new Error("Wallet not properly connected");
    }

    console.log(`Starting ${description} transaction...`);

    try {
      if (!wallet?.adapter?.connected) {
        throw new Error("Please reconnect your wallet and try again");
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      const isTransaction = instructionOrTransaction instanceof Transaction;
      
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

      // Validate transaction
      try {
        transaction.compileMessage();
      } catch (compileError) {
        console.error("Transaction validation failed:", compileError);
        throw new Error("Invalid transaction. Please check your inputs.");
      }

      console.log("Sending transaction with wallet...");
      
      let signature;
      try {
        signature = await sendTransaction(transaction, connection, {
          skipPreflight: true,
          maxRetries: 0
        });
      } catch (sendError: any) {
        const errorMsg = sendError?.message || String(sendError);
        
        if (errorMsg.includes("Unexpected error") || 
            errorMsg.includes("WalletSendTransactionError")) {
          throw new Error("WALLET_DISCONNECTED");
        }
        
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
      
      try {
        console.log("Waiting for confirmation...");
        const confirmation = await connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
        }, 'processed');
        
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        
        console.log(`${description} confirmed successfully`);
        return signature;
      } catch (confirmError: any) {
        console.warn("Confirmation may have failed, but transaction was sent:", signature);
        return signature;
      }
      
    } catch (error: any) {
      console.error(`Error in ${description}:`, error);
      const errorMessage = error?.message || String(error);
      
      if (errorMessage === "WALLET_DISCONNECTED") {
        throw new Error("Wallet disconnected unexpectedly. Please:\n• Disconnect your wallet\n• Refresh the page\n• Reconnect and try again");
      }
      
      if (errorMessage.includes("Transaction cancelled") || 
          errorMessage.includes("User rejected") ||
          errorMessage.includes("cancelled")) {
        throw new Error("Transaction was cancelled");
      }
      
      if (errorMessage.includes("insufficient funds")) {
        throw new Error("Insufficient SOL for transaction fees");
      }
      
      if (errorMessage.includes("Please reconnect")) {
        throw new Error(errorMessage);
      }
      
      throw new Error(`Transaction failed: ${errorMessage.slice(0, 100)}`);
    }
  }, [publicKey, connection, sendTransaction, wallet?.adapter]);

  // Enhanced input validation
  const validateInputs = useCallback((amount: string, unlock: string, asset: "SOL" | "SPL", balance: number) => {
    console.log("Validating inputs:", { amount, unlock, asset, balance });
    
    const trimmedAmount = amount.trim();
    if (!trimmedAmount || trimmedAmount === "") {
      throw new Error("Amount cannot be empty");
    }
    
    const amountParsed = parseFloat(trimmedAmount);
    console.log("Amount parsed:", { original: trimmedAmount, parsed: amountParsed });
    
    if (isNaN(amountParsed) || !isFinite(amountParsed)) {
      throw new Error(`Invalid amount format: "${trimmedAmount}". Must be a valid number.`);
    }
    
    if (amountParsed <= 0) {
      throw new Error(`Amount must be positive: ${amountParsed}`);
    }
    
    // ✅ CRITICAL: Kiểm tra amount có quá nhỏ không
    if (asset === "SOL" && amountParsed < 0.000000001) {
      throw new Error(`Amount too small. Minimum is 0.000000001 SOL (1 lamport)`);
    }
    
    if (asset === "SPL" && amountParsed < 0.000001) {
      throw new Error(`Amount too small. Minimum is 0.000001 USDC`);
    }
    
    if (asset === "SOL") {
      if (amountParsed > balance) {
        throw new Error(`Insufficient balance. Available: ${balance.toFixed(9)} SOL, Requested: ${amountParsed} SOL`);
      }
      
      const feeReserve = 0.01;
      if ((balance - amountParsed) < feeReserve) {
        throw new Error(`Please leave at least ${feeReserve} SOL for transaction fees. Current balance: ${balance.toFixed(4)} SOL`);
      }
    }
    
    if (!unlock || unlock.trim() === "") {
      throw new Error("Unlock time cannot be empty");
    }
    
    const unlockDate = new Date(unlock);
    console.log("Unlock date parsed:", { input: unlock, parsed: unlockDate });
    
    if (isNaN(unlockDate.getTime())) {
      throw new Error(`Invalid unlock time format: "${unlock}". Please select a valid date and time.`);
    }
    
    const unlockTs = Math.floor(unlockDate.getTime() / 1000);
    const nowTs = Math.floor(Date.now() / 1000);
    
    console.log("Timestamp validation:", {
      unlockTs,
      nowTs,
      difference: unlockTs - nowTs,
      unlockDate: unlockDate.toLocaleString(),
      currentDate: new Date().toLocaleString()
    });
    
    if (unlockTs <= nowTs) {
      throw new Error(`Unlock time must be in the future. Selected: ${unlockDate.toLocaleString()}, Current: ${new Date().toLocaleString()}`);
    }
    
    const minFutureSeconds = 60;
    if (unlockTs <= nowTs + minFutureSeconds) {
      throw new Error(`Lock time must be at least ${minFutureSeconds} seconds from now. Current difference: ${unlockTs - nowTs} seconds`);
    }
    
    console.log("✓ Input validation successful:", {
      amountParsed,
      unlockTs,
      unlockDate: unlockDate.toLocaleString()
    });
    
    return { amountParsed, unlockTs };
  }, []);

  // Fetch balance and time locks
  const fetchData = useCallback(async () => {
    if (!publicKey || !connection) return;
    
    try {
      try {
        const solBalance = await connection.getBalance(publicKey);
        setBalance(solBalance / LAMPORTS_PER_SOL);
      } catch (balanceError) {
        console.error("Error fetching balance:", balanceError);
        setBalance(0);
      }
      
      if (program && programReady && lockPda) {
        console.log("Fetching time locks...");
        const locks: TimeLockInfo[] = [];
        
        try {
          console.log("Checking PDA:", lockPda.toString());
          
          const accountInfo = await connection.getAccountInfo(lockPda);
          if (!accountInfo) {
            console.log("No lock account found");
            setTimeLocks([]);
            return;
          }

          let lockAccount;
          try {
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
            const amount = lockAccount.amount as BN;
            const unlockTimestamp = lockAccount.unlockTimestamp as BN;
            const kind = lockAccount.kind;
            const mint = lockAccount.mint as PublicKey | null;
            
            console.log("Parsed account data:", {
              initializer: initializer?.toString(),
              amount: amount?.toString(),
              unlockTimestamp: unlockTimestamp?.toString(),
              kind,
              mint: mint?.toString()
            });
            
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
      const interval = setInterval(fetchData, 15000);
      return () => clearInterval(interval);
    }
  }, [fetchData, mounted]);

  useEffect(() => {
    if (!publicKey || !program || !mounted || !programReady) return;
    try {
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

// ✅ GIẢI PHÁP CHÍNH: Sử dụng BN cho instruction arguments
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
        timeDiff: unlockTs - Math.floor(Date.now() / 1000)
      });

      if (asset === "SOL") {
        console.log("Creating SOL lock...");

        // ✅ CRITICAL FIX: Sử dụng BN cho instruction arguments
        const amountLamports = Math.floor(amountParsed * LAMPORTS_PER_SOL);
        const unlockTimestamp = unlockTs;

        console.log("Raw values before BN creation:", {
          amountParsed,
          amountLamports,
          unlockTimestamp,
          LAMPORTS_PER_SOL
        });

        // ✅ CRITICAL: Thử sử dụng anchor.BN với constructor khác
        const amountBN = new anchor.BN(amountLamports.toString(), 10);
        const timestampBN = new anchor.BN(unlockTimestamp.toString(), 10);
        
        // ✅ CRITICAL: Debug BN serialization
        console.log("BN serialization debug:", {
          amountBN: {
            value: amountBN.toString(),
            hex: amountBN.toString(16),
            bytes: amountBN.toArrayLike(Buffer, 'le', 8),
            toNumber: amountBN.toNumber(),
            isZero: amountBN.isZero(),
            isNeg: amountBN.isNeg()
          },
          timestampBN: {
            value: timestampBN.toString(),
            hex: timestampBN.toString(16),
            bytes: timestampBN.toArrayLike(Buffer, 'le', 8),
            toNumber: timestampBN.toNumber(),
            isZero: timestampBN.isZero(),
            isNeg: timestampBN.isNeg()
          }
        });
        
        // ✅ CRITICAL: Thử tạo BN với constructor khác
        const amountBN2 = new anchor.BN(amountLamports);
        const timestampBN2 = new anchor.BN(unlockTimestamp);
        
        console.log("Alternative BN creation:", {
          amountBN2: {
            value: amountBN2.toString(),
            hex: amountBN2.toString(16),
            toNumber: amountBN2.toNumber(),
            isZero: amountBN2.isZero()
          },
          timestampBN2: {
            value: timestampBN2.toString(),
            hex: timestampBN2.toString(16),
            toNumber: timestampBN2.toNumber(),
            isZero: timestampBN2.isZero()
          }
        });

        console.log("BN values for instruction:", {
          amountLamports,
          unlockTimestamp,
          amountBN: amountBN.toString(),
          timestampBN: timestampBN.toString(),
          amountBNHex: amountBN.toString(16),
          timestampBNHex: timestampBN.toString(16),
          // Kiểm tra BN serialization
          amountBytes: amountBN.toArrayLike(Buffer, 'le', 8),
          timestampBytes: timestampBN.toArrayLike(Buffer, 'le', 8)
        });

        // Validation cuối cùng
        if (amountBN.lte(new BN(0))) {
          throw new Error(`Amount BN is zero or negative: ${amountBN.toString()}`);
        }

        if (timestampBN.lte(new BN(0))) {
          throw new Error(`Timestamp BN is zero or negative: ${timestampBN.toString()}`);
        }

        // ✅ CRITICAL: Kiểm tra BN có đúng giá trị không
        if (amountBN.toNumber() !== amountLamports) {
          throw new Error(`BN amount mismatch: expected ${amountLamports}, got ${amountBN.toNumber()}`);
        }

        if (timestampBN.toNumber() !== unlockTimestamp) {
          throw new Error(`BN timestamp mismatch: expected ${unlockTimestamp}, got ${timestampBN.toNumber()}`);
        }

        console.log("Creating initialize instruction with raw number arguments...");
        
        // ✅ CRITICAL: Debug raw values trước khi tạo instruction
        console.log("Raw values debug:", {
          amountLamports,
          unlockTimestamp,
          amountLamportsType: typeof amountLamports,
          unlockTimestampType: typeof unlockTimestamp,
          amountLamportsIsInteger: Number.isInteger(amountLamports),
          unlockTimestampIsInteger: Number.isInteger(unlockTimestamp),
          amountLamportsIsSafe: Number.isSafeInteger(amountLamports),
          unlockTimestampIsSafe: Number.isSafeInteger(unlockTimestamp)
        });
        
        
        // ✅ CRITICAL: Thử tạo BN với constructor đúng
        const amountBNSimple = new anchor.BN(amountLamports);
        const timestampBNSimple = new anchor.BN(unlockTimestamp);
        
        console.log("Simple BN creation:", {
          amountBNSimple: {
            value: amountBNSimple.toString(),
            hex: amountBNSimple.toString(16),
            toNumber: amountBNSimple.toNumber(),
            isZero: amountBNSimple.isZero()
          },
          timestampBNSimple: {
            value: timestampBNSimple.toString(),
            hex: timestampBNSimple.toString(16),
            toNumber: timestampBNSimple.toNumber(),
            isZero: timestampBNSimple.isZero()
          }
        });
        
        // ✅ CRITICAL: Thử raw instruction building để tránh serialization issues
        const rawInstructionData = Buffer.alloc(8 + 8 + 8); // discriminator + u64 + i64
        
        // Discriminator cho initialize_lock_sol từ IDL
        const discriminator = Buffer.from([34, 34, 4, 174, 89, 54, 54, 8]);
        rawInstructionData.set(discriminator, 0);
        
        // Serialize amount_lamports (u64) as little-endian - browser compatible
        const amountBuffer = Buffer.alloc(8);
        const amountBigInt = BigInt(amountLamports);
        for (let i = 0; i < 8; i++) {
          amountBuffer[i] = Number((amountBigInt >> BigInt(i * 8)) & BigInt(0xFF));
        }
        rawInstructionData.set(amountBuffer, 8);
        
        // Serialize unlock_timestamp (i64) as little-endian - browser compatible
        const timestampBuffer = Buffer.alloc(8);
        const timestampBigInt = BigInt(unlockTimestamp);
        for (let i = 0; i < 8; i++) {
          timestampBuffer[i] = Number((timestampBigInt >> BigInt(i * 8)) & BigInt(0xFF));
        }
        rawInstructionData.set(timestampBuffer, 16);
        
        console.log("Raw instruction data:", {
          discriminator: discriminator.toString('hex'),
          amountLamports: amountLamports,
          amountBigInt: amountBigInt.toString(),
          amountHex: amountBuffer.toString('hex'),
          unlockTimestamp: unlockTimestamp,
          timestampBigInt: timestampBigInt.toString(),
          timestampHex: timestampBuffer.toString('hex'),
          fullData: rawInstructionData.toString('hex')
        });
        
        const initInstruction = new TransactionInstruction({
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: lockPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
          ],
          programId: program.programId,
          data: rawInstructionData
        });
        
        console.log("✅ Raw instruction created successfully!");

        // ✅ CRITICAL: Debug instruction data để kiểm tra serialization
        console.log("Instruction created successfully:", {
          programId: initInstruction.programId.toString(),
          dataLength: initInstruction.data.length,
          dataHex: Buffer.from(initInstruction.data).toString('hex'),
          keys: initInstruction.keys.map(k => ({
            pubkey: k.pubkey.toString(),
            isSigner: k.isSigner,
            isWritable: k.isWritable
          }))
        });

        // ✅ CRITICAL: Kiểm tra instruction data có chứa arguments không
        const instructionData = Buffer.from(initInstruction.data);
        console.log("Instruction data analysis:", {
          totalLength: instructionData.length,
          first8Bytes: instructionData.slice(0, 8).toString('hex'),
          last8Bytes: instructionData.slice(-8).toString('hex'),
          // Tìm kiếm amount và timestamp trong data
          containsAmount: instructionData.includes(Buffer.from(amountLamports.toString())),
          containsTimestamp: instructionData.includes(Buffer.from(unlockTimestamp.toString())),
          // Kiểm tra hex representation
          amountHex: amountLamports.toString(16),
          timestampHex: unlockTimestamp.toString(16),
          // Kiểm tra little-endian representation
          amountLE: Buffer.from(amountLamports.toString(16).padStart(16, '0'), 'hex').reverse().toString('hex'),
          timestampLE: Buffer.from(unlockTimestamp.toString(16).padStart(16, '0'), 'hex').reverse().toString('hex')
        });

        // Transfer instruction
        const transferInstruction = SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: lockPda,
          lamports: amountLamports // Raw number for SystemProgram.transfer
        });

        // Create transaction
        const transaction = new Transaction();
        
        transaction.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 1000,
          })
        );
        
        transaction.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 400000,
          })
        );
        
        transaction.add(initInstruction);
        transaction.add(transferInstruction);

        const signature = await sendTransactionSafely(transaction, "SOL lock creation");
        setTxSig(signature);

      } else {
        // SPL logic với BN
        console.log("Creating SPL lock...");

        if (!usdcMint) throw new Error("Missing USDC mint configuration");

        const amountTokens = Math.floor(amountParsed * Math.pow(10, 6));
        const unlockTimestamp = unlockTs;

        console.log("SPL raw values before BN creation:", {
          amountParsed,
          amountTokens,
          unlockTimestamp,
          decimals: 6
        });

        // ✅ CRITICAL: Thử tạo BN với constructor đúng cho SPL
        const amountBNSimple = new anchor.BN(amountTokens);
        const timestampBNSimple = new anchor.BN(unlockTimestamp);
        
        console.log("Simple SPL BN creation:", {
          amountBNSimple: {
            value: amountBNSimple.toString(),
            hex: amountBNSimple.toString(16),
            toNumber: amountBNSimple.toNumber(),
            isZero: amountBNSimple.isZero()
          },
          timestampBNSimple: {
            value: timestampBNSimple.toString(),
            hex: timestampBNSimple.toString(16),
            toNumber: timestampBNSimple.toNumber(),
            isZero: timestampBNSimple.isZero()
          }
        });

        console.log("SPL BN values:", {
          amountTokens,
          unlockTimestamp,
          amountBNSimple: amountBNSimple.toString(),
          timestampBNSimple: timestampBNSimple.toString(),
          amountBNSimpleHex: amountBNSimple.toString(16),
          timestampBNSimpleHex: timestampBNSimple.toString(16)
        });

        if (amountBNSimple.lte(new BN(0)) || timestampBNSimple.lte(new BN(0))) {
          throw new Error(`Invalid SPL BN values: amount=${amountBNSimple.toString()}, timestamp=${timestampBNSimple.toString()}`);
        }

        // ✅ CRITICAL: Kiểm tra BN có đúng giá trị không
        if (amountBNSimple.toNumber() !== amountTokens) {
          throw new Error(`SPL BN amount mismatch: expected ${amountTokens}, got ${amountBNSimple.toNumber()}`);
        }

        if (timestampBNSimple.toNumber() !== unlockTimestamp) {
          throw new Error(`SPL BN timestamp mismatch: expected ${unlockTimestamp}, got ${timestampBNSimple.toNumber()}`);
        }

        const userAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
        const vaultAta = getAssociatedTokenAddressSync(usdcMint, lockPda, true);

        // ✅ CRITICAL: Debug values cho SPL
        console.log("Final SPL values before instruction:", {
          amountTokens,
          unlockTimestamp,
          amountTokensType: typeof amountTokens,
          unlockTimestampType: typeof unlockTimestamp,
          amountTokensIsNumber: Number.isInteger(amountTokens),
          unlockTimestampIsNumber: Number.isInteger(unlockTimestamp)
        });

        let instruction;
        try {
          // ✅ CRITICAL: Sử dụng đúng tên instruction từ IDL (snake_case)
          instruction = await program.methods
            .initialize_lock_spl(amountBNSimple, timestampBNSimple) // <-- SNAKE_CASE từ IDL
            .accounts({
              initializer: publicKey,
              lock_account: lockPda,
              mint: usdcMint,
              user_ata: userAta,
              vault_ata: vaultAta,
              token_program: TOKEN_PROGRAM_ID,
              associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
              system_program: SystemProgram.programId,
            })
            .instruction();
          console.log("✅ snake_case instruction name worked for SPL!");
        } catch (snakeCaseError) {
          console.log("snake_case instruction name failed for SPL:", snakeCaseError);
          try {
            // Fallback to camelCase
            instruction = await program.methods
              .initializeLockSpl(amountBNSimple, timestampBNSimple) // <-- CAMELCASE fallback
            .accounts({
              initializer: publicKey,
              lockAccount: lockPda,
              mint: usdcMint,
              userAta: userAta,
              vaultAta: vaultAta,
              tokenProgram: TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .instruction();
            console.log("✅ camelCase fallback worked for SPL!");
        } catch (camelCaseError) {
            console.log("Both instruction naming conventions failed for SPL:", camelCaseError);
            throw camelCaseError;
          }
        }

        const signature = await sendTransactionSafely(instruction, "SPL lock creation");
        setTxSig(signature);
      }

      // Clear and refresh
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
  }, [asset, amount, connected, lockPda, lockBump, program, publicKey, unlock, usdcMint, fetchData, programReady, balance, loading, sendTransactionSafely, wallet?.adapter, validateInputs]);

  const withdraw = useCallback(async (targetLock?: TimeLockInfo) => {
    if (!connected || !publicKey || !program || !lockPda || !programReady) {
      setError("Program not ready. Please wait or reconnect your wallet.");
      return;
    }

    // ✅ CRITICAL: Kiểm tra program có methods không
    if (!program.methods) {
      setError("Program methods not available");
      setLoading(false);
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

        // ✅ CRITICAL FIX: Raw instruction building for SOL withdrawal
        console.log("Building raw SOL withdrawal instruction...");
        
        // Tạo raw instruction data cho withdraw_sol
        const rawInstructionData = Buffer.alloc(8); // Chỉ có discriminator
        const discriminator = Buffer.from([145, 131, 74, 136, 65, 137, 42, 38]); // withdraw_sol discriminator từ IDL
        
        rawInstructionData.set(discriminator, 0);
        
        console.log("Raw SOL withdrawal instruction data:", {
          hex: rawInstructionData.toString('hex'),
          length: rawInstructionData.length,
          discriminator: discriminator.toString('hex')
        });
        
        const instruction = new TransactionInstruction({
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: lockPda, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
          ],
          programId: program.programId,
          data: rawInstructionData
        });
        
        console.log("✅ Raw SOL withdrawal instruction created successfully!");
        
        const signature = await sendTransactionSafely(instruction, "SOL withdrawal");
        setTxSig(signature);
        
      } else {
        if (!usdcMint) throw new Error("Missing USDC mint configuration");

        const userAta = getAssociatedTokenAddressSync(usdcMint, publicKey);
        const vaultAta = getAssociatedTokenAddressSync(usdcMint, lockPda, true);

        console.log("Withdrawing SPL lock");

        // ✅ CRITICAL FIX: Raw instruction building for SPL withdrawal
        console.log("Building raw SPL withdrawal instruction...");
        
        // Tạo raw instruction data cho withdraw_spl
        const rawInstructionData = Buffer.alloc(8); // Chỉ có discriminator
        const discriminator = Buffer.from([181, 154, 94, 86, 62, 115, 6, 186]); // withdraw_spl discriminator từ IDL
        
        rawInstructionData.set(discriminator, 0);
        
        console.log("Raw SPL withdrawal instruction data:", {
          hex: rawInstructionData.toString('hex'),
          length: rawInstructionData.length,
          discriminator: discriminator.toString('hex')
        });
        
        const instruction = new TransactionInstruction({
          keys: [
            { pubkey: publicKey, isSigner: true, isWritable: true },
            { pubkey: lockPda, isSigner: false, isWritable: true },
            { pubkey: usdcMint, isSigner: false, isWritable: false },
            { pubkey: userAta, isSigner: false, isWritable: true },
            { pubkey: vaultAta, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
          ],
          programId: program.programId,
          data: rawInstructionData
        });
        
        console.log("✅ Raw SPL withdrawal instruction created successfully!");
        
        const signature = await sendTransactionSafely(instruction, "SPL withdrawal");
        setTxSig(signature);
      }
      
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
    
    if (loading) {
      console.log("Transaction already in progress, ignoring...");
      return;
    }
    
    setLoading(true);
    setError("");
    setTxSig("");
    
    try {
      console.log("Requesting airdrop for:", publicKey.toString());
      const sig = await connection.requestAirdrop(publicKey, 1 * LAMPORTS_PER_SOL);
      console.log("Airdrop signature:", sig);
      
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
      
      setTimeout(() => fetchData(), 5000);
      
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Error airdropping:", e);
      
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

  // Helper function to format error messages
  const formatErrorMessage = (errorMessage: string): string => {
    const lowerError = errorMessage.toLowerCase();
    
    if (lowerError.includes("transaction was cancelled") || lowerError.includes("cancelled")) {
      return "Transaction was cancelled";
    } else if (lowerError.includes("user rejected")) {
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

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const getMinDateTime = () => {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 1);
    return now.toISOString().slice(0, 16);
  };

  const isAmountValid = (amt: string): boolean => {
    const num = parseFloat(amt.trim());
    return !isNaN(num) && isFinite(num) && num > 0;
  };

  const isUnlockTimeValid = (time: string): boolean => {
    const date = new Date(time);
    if (isNaN(date.getTime())) return false;
    const unlockTs = Math.floor(date.getTime() / 1000);
    const nowTs = Math.floor(Date.now() / 1000);
    return unlockTs > nowTs + 60;
  };

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
      background: "#0a0a0a", // Dark background like Solana.com
      padding: "1.5rem"
    }}>
      <div className="main-content" style={{
        maxWidth: "72rem",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "2rem"
      }}>
        {/* Header - 2 Column Layout */}
        <div className="header-grid" style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "2rem",
          alignItems: "center",
          marginBottom: "2rem"
        }}>
          {/* Left Column - Title */}
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            {/* Solana Logo */}
            <div style={{
              width: "120px",
              height: "120px",
              borderRadius: "16px",
              overflow: "hidden",
          display: "flex",
          alignItems: "center",
              justifyContent: "center"
            }}>
              <Image
                src="/solana.png"
                alt="Solana Logo"
                width={80}
                height={80}
                style={{
                  objectFit: "contain"
                }}
              />
            </div>
            
          <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
                <h1 style={{
                  fontSize: "2.5rem",
                  fontWeight: "700",
                  color: "#ffffff",
                  margin: 0,
                  background: "linear-gradient(135deg, #ffffff 0%, #14f195 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                  backgroundClip: "text"
            }}>
              Time-Locked Wallet
            </h1>
                {/* SuperteamVN Logo */}
                <div style={{
                  width: "30px",
                  height: "30px",
                  borderRadius: "50%",
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center"
                }}>
                  <Image
                    src="/superteamvn.jpg"
                    alt="SuperteamVN Logo"
                    width={56}
                    height={56}
                    style={{
                      objectFit: "cover",
                      borderRadius: "50%"
                    }}
                  />
                </div>
              </div>
            <p style={{
                color: "#a1a1aa",
                marginTop: "0.5rem",
                fontSize: "1.125rem",
                margin: 0,
                display: "flex",
                alignItems: "center",
                gap: "0.5rem"
              }}>
                <span>Secure your assets with time-based locks on</span>
                <span style={{
                  color: "#14f195",
                  fontWeight: "600"
                }}>Solana</span>
            </p>
          </div>
          </div>

          {/* Right Column - Wallet Info */}
          <div className="header-right" style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: "1rem"
          }}>
          <DynamicWalletMultiButton className="btn-primary" />
            
            {connected && (
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: "0.25rem",
                fontSize: "0.875rem",
                color: "#a1a1aa"
              }}>
                <div><strong>Program ID:</strong> {program?.programId?.toString().slice(0, 8)}...</div>
                <div><strong>Lock PDA:</strong> {lockPda?.toString().slice(0, 8)}...</div>
                <div><strong>Status:</strong> {programReady ? '✅ Ready' : '⏳ Loading'}</div>
              </div>
            )}
          </div>
        </div>

        {/* Wallet Error Display */}
        {walletError && (
          <div style={{
            background: "rgba(239, 68, 68, 0.1)",
            border: "1px solid rgba(239, 68, 68, 0.3)",
            borderRadius: "0.75rem",
            padding: "1rem",
            color: "#fca5a5",
            marginBottom: "1rem",
            backdropFilter: "blur(10px)"
          }}>
            {walletError}
          </div>
        )}

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



        {connected && (
          <>
            {/* Balance and Actions */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: "1.5rem"
            }}>
              <div style={{
                borderRadius: "1rem",
                padding: "1.5rem",
                background: "rgba(255, 255, 255, 0.05)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                backdropFilter: "blur(10px)"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "8px",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center"
                  }}>
                    <Image
                      src="/solana.png"
                      alt="Solana Logo"
                      width={40}
                      height={40}
                      style={{
                        objectFit: "contain"
                      }}
                    />
                  </div>
                <h3 style={{
                  fontSize: "1.125rem",
                  fontWeight: "600",
                    color: "#ffffff",
                    margin: 0
                }}>
                  Wallet Balance
                </h3>
                </div>
                <div style={{
                  fontSize: "1.875rem",
                  fontWeight: "700",
                  color: "#14f195",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem"
                }}>
                  {balance.toFixed(4)} 
                  <span style={{
                    fontSize: "1.25rem",
                    color: "#ffffff"
                  }}>SOL</span>
                </div>
              </div>
              
              <div style={{
                borderRadius: "1rem",
                padding: "1.5rem",
                background: "rgba(255, 255, 255, 0.05)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                backdropFilter: "blur(10px)"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
                  <div style={{
                    width: "24px",
                    height: "24px",
                    background: "linear-gradient(135deg, #ff6b35 0%, #f7931e 100%)",
                    borderRadius: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "12px",
                    fontWeight: "bold",
                    color: "#ffffff"
                  }}>
                    ⚡
                  </div>
                <h3 style={{
                  fontSize: "1.125rem",
                  fontWeight: "600",
                    color: "#ffffff",
                    margin: 0
                }}>
                  Quick Actions
                </h3>
                </div>
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
            <div style={{
              borderRadius: "1rem",
              padding: "1.5rem",
              background: "rgba(255, 255, 255, 0.05)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              backdropFilter: "blur(10px)"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.5rem" }}>
                <div style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "8px",
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "linear-gradient(135deg, #14f195 0%, #00d4aa 100%)"
                }}>
                  <span style={{ color: "#0a0a0a", fontWeight: "bold", fontSize: "16px" }}>🔒</span>
                </div>
              <h3 style={{
                fontSize: "1.25rem",
                fontWeight: "600",
                  color: "#ffffff",
                  margin: 0
              }}>
                Create New Time Lock
              </h3>
              </div>
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
              <div style={{
                borderRadius: "1rem",
                padding: "1.5rem",
                background: "rgba(255, 255, 255, 0.05)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
                backdropFilter: "blur(10px)"
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1.5rem" }}>
                  <div style={{
                    width: "48px",
                    height: "48px",
                    borderRadius: "50%",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center"
                  }}>
                    <Image
                      src="/superteamvn.jpg"
                      alt="SuperteamVN Logo"
                      width={48}
                      height={48}
                      style={{
                        objectFit: "cover",
                        borderRadius: "50%"
                      }}
                    />
                  </div>
                <h3 style={{
                  fontSize: "1.25rem",
                  fontWeight: "600",
                    color: "#ffffff",
                    margin: 0
                }}>
                  Your Time Locks
                </h3>
                </div>
                <div style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "1rem"
                }}>
                  {timeLocks.map((lock, index) => (
                    <div key={index} style={{
                      background: "rgba(255, 255, 255, 0.05)",
                      borderRadius: "0.75rem",
                      padding: "1rem",
                      border: "1px solid rgba(255, 255, 255, 0.1)",
                      backdropFilter: "blur(10px)"
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
                            <TimeRemaining unlockTimestamp={lock.unlockTimestamp} />
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
          background: #14f195;
          border: none;
          border-radius: 0.75rem;
          padding: 0.75rem 1.5rem;
          color: #0a0a0a;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 4px 15px rgba(20, 241, 149, 0.3);
        }
        
        .btn-primary:hover:not(:disabled) {
          background: #00d4aa;
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(20, 241, 149, 0.4);
        }
        
        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .btn-secondary {
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 0.5rem;
          padding: 0.5rem 1rem;
          color: #ffffff;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          backdropFilter: blur(10px);
        }
        
        .btn-secondary:hover:not(:disabled) {
          background: rgba(255, 255, 255, 0.15);
          border-color: rgba(255, 255, 255, 0.3);
        }
        
        .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        
        .input-field {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 0.5rem;
          padding: 0.75rem 1rem;
          color: #ffffff;
          font-size: 0.875rem;
          transition: border-color 0.2s;
          backdropFilter: blur(10px);
        }
        
        .input-field:focus {
          outline: none;
          border-color: #14f195;
          box-shadow: 0 0 0 2px rgba(20, 241, 149, 0.1);
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
          background: #14f195 !important;
          color: #0a0a0a !important;
          border: none !important;
          border-radius: 0.75rem !important;
          font-weight: 600 !important;
          transition: all 0.2s !important;
          position: relative !important;
          z-index: 10 !important;
          cursor: pointer !important;
          pointer-events: auto !important;
          user-select: none !important;
        }
        
        :global(.wallet-adapter-button:hover) {
          background: #00d4aa !important;
          transform: translateY(-2px);
        }
        
        :global(.wallet-adapter-button-trigger) {
          background: #14f195 !important;
          color: #0a0a0a !important;
          cursor: pointer !important;
          pointer-events: auto !important;
        }
        
        /* ✅ CRITICAL: Ensure wallet button is clickable */
        :global(.wallet-adapter-button:not(:disabled)) {
          cursor: pointer !important;
          pointer-events: auto !important;
        }
        
        :global(.wallet-adapter-button:disabled) {
          cursor: not-allowed !important;
          pointer-events: none !important;
        }
        
        /* ✅ CRITICAL: Fix wallet dropdown overlay issues */
        :global(.wallet-adapter-dropdown) {
          z-index: 99999 !important;
          position: relative !important;
        }
        
        :global(.wallet-adapter-dropdown-list) {
          z-index: 99999 !important;
          position: fixed !important;
          top: auto !important;
          right: auto !important;
          left: auto !important;
          bottom: auto !important;
          background: rgba(10, 10, 10, 0.98) !important;
          border: 1px solid rgba(255, 255, 255, 0.2) !important;
          border-radius: 0.75rem !important;
          backdrop-filter: blur(20px) !important;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8) !important;
          min-width: 200px !important;
        }
        
        :global(.wallet-adapter-dropdown-list-active) {
          z-index: 99999 !important;
        }
        
        :global(.wallet-adapter-dropdown-list-item) {
          color: #ffffff !important;
          padding: 0.75rem 1rem !important;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
        }
        
        :global(.wallet-adapter-dropdown-list-item:hover) {
          background: rgba(255, 255, 255, 0.1) !important;
        }
        
        :global(.wallet-adapter-dropdown-list-item:last-child) {
          border-bottom: none !important;
        }
        
        /* ✅ CRITICAL: Ensure proper z-index stacking */
        :global(.wallet-adapter-modal) {
          z-index: 10000 !important;
          pointer-events: auto !important;
        }
        
        :global(.wallet-adapter-modal-overlay) {
          z-index: 9999 !important;
          pointer-events: auto !important;
        }
        
        :global(.wallet-adapter-modal-wrapper) {
          z-index: 10001 !important;
          pointer-events: auto !important;
        }
        
        :global(.wallet-adapter-modal-container) {
          pointer-events: auto !important;
        }
        
        :global(.wallet-adapter-modal-list) {
          pointer-events: auto !important;
        }
        
        :global(.wallet-adapter-modal-list-item) {
          pointer-events: auto !important;
          cursor: pointer !important;
        }
        
        /* Ensure main content doesn't interfere with wallet dropdown */
        .main-content {
          position: relative;
          z-index: 1;
        }
        
        /* Responsive design */
        @media (max-width: 768px) {
          .glass-effect {
            padding: 1rem !important;
          }
          
          .gradient-text {
            font-size: 1.875rem !important;
          }
          
          /* Mobile header layout */
          .header-grid {
            grid-template-columns: 1fr !important;
            gap: 1rem !important;
          }
          
          .header-right {
            align-items: flex-start !important;
          }
        }
        {/* Footer */}
        <div style={{
          marginTop: "3rem",
          padding: "2rem",
          textAlign: "center",
          borderTop: "1px solid rgba(255, 255, 255, 0.1)"
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            marginBottom: "1rem",
            flexWrap: "wrap"
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 1rem",
              background: "rgba(255, 255, 255, 0.05)",
              borderRadius: "0.5rem",
              border: "1px solid rgba(255, 255, 255, 0.1)"
            }}>
              <div style={{
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
              }}>
                <Image
                  src="/solana.png"
                  alt="Solana Logo"
                  width={32}
                  height={32}
                  style={{
                    objectFit: "contain"
                  }}
                />
              </div>
              <span style={{ color: "#ffffff", fontSize: "0.875rem", fontWeight: "500" }}>
                Powered by Solana
              </span>
            </div>
            
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 1rem",
              background: "rgba(255, 255, 255, 0.05)",
              borderRadius: "0.5rem",
              border: "1px solid rgba(255, 255, 255, 0.1)"
            }}>
              <div style={{
                width: "32px",
                height: "32px",
                borderRadius: "50%",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
              }}>
                <Image
                  src="/superteamvn.jpg"
                  alt="SuperteamVN Logo"
                  width={32}
                  height={32}
                  style={{
                    objectFit: "cover",
                    borderRadius: "50%"
                  }}
                />
              </div>
              <span style={{ color: "#ffffff", fontSize: "0.875rem", fontWeight: "500" }}>
                Built by SuperteamVN
              </span>
            </div>
          </div>
          
          <p style={{
            color: "#a1a1aa",
            fontSize: "0.875rem",
            margin: 0
          }}>
            Secure, decentralized time-locked asset management on Solana blockchain
          </p>
        </div>
      `}</style>
    </div>
  );
}