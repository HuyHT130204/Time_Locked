import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl } from "@coral-xyz/anchor";
import idlJson from "@/idl/timelock_wallet.json";

interface ProgramResult {
  program: Program;
  provider: AnchorProvider;
  connection: Connection;
}

// Transform the IDL to ensure proper structure for Anchor
function transformIdl(rawIdl: any): Idl {
  // Deep clone to avoid mutating the original
  const idl = JSON.parse(JSON.stringify(rawIdl));
  
  // Ensure top-level arrays exist
  if (!idl.version) idl.version = "0.1.0";
  if (!idl.name) idl.name = (idl.metadata && idl.metadata.name) || "timelock_wallet";
  if (!idl.instructions) idl.instructions = [];
  if (!idl.accounts) idl.accounts = [];
  if (!idl.types) idl.types = [];
  if (!idl.events) idl.events = [];
  if (!idl.errors) idl.errors = [];
  if (!idl.constants) idl.constants = [];

  const normalizePrimitive = (t: any) => {
    if (t === "pubkey") return "publicKey";
    return t;
  };
  const primitiveSet = new Set(["u8","u16","u32","u64","u128","i8","i16","i32","i64","i128","f32","f64","bool","bytes","string","publicKey"]);

  // Build quick lookup for types by name
  const typeByName = new Map<string, any>();
  if (Array.isArray(idl.types)) {
    for (const t of idl.types) {
      if (t && typeof t.name === "string") {
        typeByName.set(t.name, t);
      }
    }
  }

  // Normalize "defined" references and primitives in fields; also wrap option primitives
  if (Array.isArray(idl.types)) {
    idl.types = idl.types.map((typeDef: any) => {
      if (typeDef && typeDef.type) {
        const td = typeDef.type;
        if (td.kind === "struct" && Array.isArray(td.fields)) {
          td.fields = td.fields.map((field: any) => {
            // Normalize direct primitive names
            if (typeof field.type === "string") {
              return { ...field, type: normalizePrimitive(field.type) };
            }
            if (field && field.type && typeof field.type === "object") {
              // defined may be { name: "Type" } or just "Type"
              if (Object.prototype.hasOwnProperty.call(field.type, "defined")) {
                const def = field.type.defined;
                const defName = typeof def === "string" ? def : (def && def.name) ? def.name : def;
                if (primitiveSet.has(normalizePrimitive(defName))) {
                  return { ...field, type: normalizePrimitive(defName) };
                }
                return { ...field, type: { defined: defName } };
              }
              // option may be a primitive string; wrap into proper form
              if (Object.prototype.hasOwnProperty.call(field.type, "option")) {
                const opt = field.type.option;
                if (typeof opt === "string") {
                  const p = normalizePrimitive(opt);
                  if (primitiveSet.has(p)) return { ...field, type: { option: p } };
                  return { ...field, type: { option: { defined: p } } };
                }
                if (opt && typeof opt === "object" && Object.prototype.hasOwnProperty.call(opt, "defined")) {
                  const def = opt.defined;
                  const defName = typeof def === "string" ? def : (def && def.name) ? def.name : def;
                  const n = normalizePrimitive(defName);
                  if (primitiveSet.has(n)) {
                    return { ...field, type: { option: n } };
                  }
                  return { ...field, type: { option: { defined: n } } };
                }
              }
            }
            return field;
          });
        }
        if (td.kind === "enum" && Array.isArray(td.variants)) {
          td.variants = td.variants.map((v: any) => {
            if (typeof v === "string") return { name: v };
            return v;
          });
        }
      }
      return typeDef;
    });
  }

  // Ensure each account has an inline type definition; if missing, copy from types by name
  if (Array.isArray(idl.accounts)) {
    idl.accounts = idl.accounts.map((account: any) => {
      if (!account) return account;
      if (!account.type && account.name && typeByName.has(account.name)) {
        const referenced = typeByName.get(account.name);
        if (referenced && referenced.type) {
          account.type = referenced.type;
        }
      }
      return account;
    });
  }

  // Strip PDA metadata from instruction accounts to avoid client-side auto PDA resolution issues
  if (Array.isArray(idl.instructions)) {
    idl.instructions = idl.instructions.map((ix: any) => {
      if (Array.isArray(ix.accounts)) {
        ix.accounts = ix.accounts.map((acc: any) => {
          if (acc && acc.pda) {
            delete acc.pda;
          }
          return acc;
        });
      }
      return ix;
    });
  }

  return idl as Idl;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAnchorProgram(wallet: any, connection?: Connection): ProgramResult {
  const endpoint = process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
  const conn = connection ?? new Connection(endpoint, { 
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60000
  });
  
  if (!wallet) {
    throw new Error("Wallet not connected");
  }
  
  // Handle different wallet adapter structures
  const actualWallet = wallet.adapter || wallet;
  const publicKey = actualWallet.publicKey;
  
  if (!publicKey) {
    throw new Error("Wallet not ready. Please connect and authorize your wallet.");
  }

  if (!actualWallet.signTransaction || !actualWallet.signAllTransactions) {
    throw new Error("Wallet does not support required signing methods.");
  }

  // Create a proper Anchor wallet interface for web wallets
  const anchorWallet = {
    publicKey,
    signTransaction: actualWallet.signTransaction.bind(actualWallet),
    signAllTransactions: actualWallet.signAllTransactions.bind(actualWallet),
  };
  
  const provider = new AnchorProvider(conn, anchorWallet, { 
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false
  });
  
  // Prefer env PROGRAM_ID to override IDL address to avoid mismatch errors
  const programIdStr = process.env.NEXT_PUBLIC_PROGRAM_ID || idlJson.address || "BYnFQAAsnkMVwsxVDVet7vLfefAaLScExNxKEEjA6NkD";
  const programId = new PublicKey(programIdStr);
  
  // Create program with proper error handling
  let program: Program;
  try {
    const transformedIdl = transformIdl(idlJson);
    program = new Program(transformedIdl, programId, provider);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to create program: ${error.message}`);
    }
    throw new Error(`Failed to create program: ${String(error)}`);
  }
  
  return { program, provider, connection: conn };
}