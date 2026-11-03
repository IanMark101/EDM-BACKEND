export function secureDirectory(directory: string): Promise<void>;
export function keyFor(directory: string): Promise<Buffer>;
export function encryptSnapshot(data: Uint8Array, key: Uint8Array): Buffer;
export function decryptSnapshot(data: Uint8Array, key: Uint8Array): Buffer;
