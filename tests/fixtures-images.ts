/** Minimal encoded image headers (enough for size detection), base64. */

function chunk(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

export function png(width: number, height: number, pad = 64): string {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), Buffer.alloc(pad, 7)]).toString("base64");
}

/** JPEG with an APP0 segment and a large EXIF-like APP1 before the frame header. */
export function jpeg(width: number, height: number, app1 = 3000): string {
	const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
	const exif = Buffer.alloc(app1 + 4, 0x41);
	exif[0] = 0xff;
	exif[1] = 0xe1;
	exif.writeUInt16BE(app1 + 2, 2);
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, exif, sof, Buffer.alloc(64, 1)]).toString("base64");
}

export function gif(width: number, height: number): string {
	const b = Buffer.alloc(32);
	b.write("GIF89a", 0, "latin1");
	b.writeUInt16LE(width, 6);
	b.writeUInt16LE(height, 8);
	return b.toString("base64");
}

export function webpVp8x(width: number, height: number): string {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0, "latin1");
	b.writeUInt32LE(32, 4);
	b.write("WEBP", 8, "latin1");
	b.write("VP8X", 12, "latin1");
	b.writeUIntLE(width - 1, 24, 3);
	b.writeUIntLE(height - 1, 27, 3);
	return b.toString("base64");
}

export function webpLossless(width: number, height: number): string {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0, "latin1");
	b.write("WEBP", 8, "latin1");
	b.write("VP8L", 12, "latin1");
	b[20] = 0x2f;
	b.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
	return b.toString("base64");
}

export const image = (data: string, mimeType = "image/png") => ({ type: "image" as const, data, mimeType });
