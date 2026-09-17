/** A connected signer the UI hands to the pool client. Real wallet or (mock only) demo wallet. */
export type Session = {
  address: string;
  walletName: string;
  walletIcon?: string;
  signMessage: (bytes: Uint8Array) => Promise<Uint8Array>;
  signAndSend: (tx: Uint8Array) => Promise<string>;
  disconnect: () => Promise<void>;
};
