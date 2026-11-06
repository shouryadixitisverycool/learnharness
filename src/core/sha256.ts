/**
 * SHA-256 in pure TypeScript — byte-identical to node:crypto's
 * createHash("sha256"), so persisted digests (coverage fingerprints,
 * batch tags) survive the swap. Exists because importing node:crypto
 * from core drags the whole crypto-browserify polyfill into every
 * client bundle (the core barrel re-exports coverage.ts); this module
 * has zero imports and runs anywhere.
 *
 * Sync by design: the callers (coverage fingerprints) are sync and the
 * web-crypto subtle API is async, so only a local implementation keeps
 * the call sites unchanged.
 */

// Round constants: first 32 bits of the fractional parts of the cube
// roots of the first 64 primes (FIPS 180-4 §4.2.2).
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const W = new Uint32Array(64);

function compress(h: Uint32Array, block: Uint8Array, offset: number): void {
	for (let t = 0; t < 16; t++) {
		const i = offset + t * 4;
		W[t] = ((block[i]! << 24) | (block[i + 1]! << 16) | (block[i + 2]! << 8) | block[i + 3]!) >>> 0;
	}
	for (let t = 16; t < 64; t++) {
		const w15 = W[t - 15]!;
		const w2 = W[t - 2]!;
		const s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
		const s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
		W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
	}
	let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
	for (let t = 0; t < 64; t++) {
		const s1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
		const ch = ((e & f) ^ (~e & g)) >>> 0;
		const t1 = (hh + s1 + ch + K[t]! + W[t]!) >>> 0;
		const s0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
		const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
		const t2 = (s0 + maj) >>> 0;
		hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
	}
	h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
	h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
}

const encoder = new TextEncoder();

/** Streaming sha256 mirroring the node:crypto Hash subset coverage needs. */
export class Sha256 {
	private readonly h = new Uint32Array(H0);
	private readonly block = new Uint8Array(64);
	private blockLen = 0;
	private lenHi = 0; // total length in bits, high 32 bits
	private lenLo = 0; // total length in bits, low 32 bits

	update(data: string): this {
		const bytes = encoder.encode(data);
		this.addBits(bytes.length * 8);
		let offset = 0;
		while (offset < bytes.length) {
			const take = Math.min(64 - this.blockLen, bytes.length - offset);
			this.block.set(bytes.subarray(offset, offset + take), this.blockLen);
			this.blockLen += take;
			offset += take;
			if (this.blockLen === 64) {
				compress(this.h, this.block, 0);
				this.blockLen = 0;
			}
		}
		return this;
	}

	private addBits(bits: number): void {
		this.lenLo = (this.lenLo + bits) >>> 0;
		if (this.lenLo < bits) this.lenHi = (this.lenHi + 1) >>> 0;
	}

	digest(encoding: "hex"): string {
		// Clone so digest() is idempotent like node's (digest ends the stream
		// there, but nothing here calls update after digest).
		const h = new Uint32Array(this.h);
		const block = new Uint8Array(this.block);
		let blockLen = this.blockLen;
		block[blockLen++] = 0x80;
		if (blockLen > 56) {
			block.fill(0, blockLen, 64);
			compress(h, block, 0);
			blockLen = 0;
		}
		block.fill(0, blockLen, 56);
		const dv = new DataView(block.buffer);
		dv.setUint32(56, this.lenHi);
		dv.setUint32(60, this.lenLo);
		compress(h, block, 0);
		let out = "";
		if (encoding === "hex") {
			for (let i = 0; i < 8; i++) out += h[i]!.toString(16).padStart(8, "0");
		}
		return out;
	}
}

/** One-shot sha256 hex digest of one or more UTF-8 string chunks. */
export function sha256Hex(chunks: string | ReadonlyArray<string>): string {
	const h = new Sha256();
	if (typeof chunks === "string") h.update(chunks);
	else for (const chunk of chunks) h.update(chunk);
	return h.digest("hex");
}
