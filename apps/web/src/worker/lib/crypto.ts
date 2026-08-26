export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

export function base64UrlDecode(input: string): Uint8Array {
  const padding = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const binary = atob(input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined) return false;
    difference |= left ^ right;
  }
  return difference === 0;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  return timingSafeEqual(utf8Bytes(a), utf8Bytes(b));
}
