/** ExtData hash: Borsh(recipient, ext_amount i64, enc1, enc2, fee u64, fee_recipient, mint) → SHA-256. Must match the program. */
import { PublicKey } from '@solana/web3.js';
import * as borsh from 'borsh';
import { sha256 } from '@noble/hashes/sha2';

export type ExtData = {
  recipient: PublicKey;
  extAmount: bigint; // i64
  encryptedOutput1: Uint8Array;
  encryptedOutput2: Uint8Array;
  fee: bigint; // u64
  feeRecipient: PublicKey;
  mint: PublicKey;
};

const schema = {
  struct: {
    recipient: { array: { type: 'u8', len: 32 } },
    extAmount: 'i64',
    encryptedOutput1: { array: { type: 'u8' } },
    encryptedOutput2: { array: { type: 'u8' } },
    fee: 'u64',
    feeRecipient: { array: { type: 'u8', len: 32 } },
    mintAddress: { array: { type: 'u8', len: 32 } },
  },
} as const;

export function extDataHash(e: ExtData): Uint8Array {
  const bytes = borsh.serialize(schema as never, {
    recipient: e.recipient.toBytes(),
    extAmount: e.extAmount,
    encryptedOutput1: e.encryptedOutput1,
    encryptedOutput2: e.encryptedOutput2,
    fee: e.fee,
    feeRecipient: e.feeRecipient.toBytes(),
    mintAddress: e.mint.toBytes(),
  });
  return sha256(bytes);
}
