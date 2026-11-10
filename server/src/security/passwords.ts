import argon2 from 'argon2';

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string): Promise<string> => argon2.hash(pw, OPTIONS);

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/** Burn equivalent time for unknown usernames so login timing doesn't reveal which exist. */
export async function dummyVerify(pw: string): Promise<void> {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, pw);
}
