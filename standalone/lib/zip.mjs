import fs from 'node:fs';
import { crc32 } from 'node:zlib';

/** DOS date/time from unix seconds. */
function dos(sec) {
  const d = new Date(sec * 1000);
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/**
 * Stream a store-only (uncompressed) ZIP64 archive of entries [{ name, file, mtime }] to out.
 * Photos and videos are already compressed, so storing is as small as deflating and far faster.
 */
export async function zipStream(out, entries) {
  // Stop as soon as the client goes away (otherwise we wait for 'drain' forever and leak the read stream)
  let closed = false;
  out.once('close', () => (closed = true));
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error('client closed'));
      if (out.write(buf)) return resolve();
      const done = () => {
        out.off('drain', done);
        out.off('close', done);
        closed ? reject(new Error('client closed')) : resolve();
      };
      out.on('drain', done);
      out.on('close', done);
    });
  try {
    await writeEntries();
  } catch {
    if (!closed) out.destroy();
  }

  async function writeEntries() {
    const used = new Set();
    const central = [];
    let offset = 0;

    for (const e of entries) {
      let name = e.name;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = e.name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
      used.add(name.toLowerCase());
      const nameBuf = Buffer.from(name, 'utf8');
      const { time, date } = dos(e.mtime);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(45, 4);
      local.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(0xffffffff, 18);
      local.writeUInt32LE(0xffffffff, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(20, 28);
      const zip64Local = Buffer.concat([Buffer.from([1, 0, 16, 0]), u64(0), u64(0)]);
      await write(Buffer.concat([local, nameBuf, zip64Local]));
      const start = offset;
      offset += local.length + nameBuf.length + zip64Local.length;

      let crc = 0;
      let size = 0;
      try {
        for await (const chunk of fs.createReadStream(e.file)) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          await write(chunk);
        }
      } catch (e) {
        if (closed) throw e;
        // File vanished mid-download: entry stays empty but the archive stays valid
      }
      offset += size;

      const desc = Buffer.alloc(24);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeBigUInt64LE(BigInt(size), 8);
      desc.writeBigUInt64LE(BigInt(size), 16);
      await write(desc);
      offset += desc.length;

      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(45, 4);
      cd.writeUInt16LE(45, 6);
      cd.writeUInt16LE(0x0808, 8);
      cd.writeUInt16LE(0, 10);
      cd.writeUInt16LE(time, 12);
      cd.writeUInt16LE(date, 14);
      cd.writeUInt32LE(crc >>> 0, 16);
      cd.writeUInt32LE(0xffffffff, 20);
      cd.writeUInt32LE(0xffffffff, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(28, 30);
      cd.writeUInt32LE(0xffffffff, 42);
      central.push(Buffer.concat([cd, nameBuf, Buffer.from([1, 0, 24, 0]), u64(size), u64(size), u64(start)]));
    }

    const cdBuf = Buffer.concat(central);
    const cdStart = offset;
    const eocd64 = Buffer.alloc(56);
    eocd64.writeUInt32LE(0x06064b50, 0);
    eocd64.writeBigUInt64LE(44n, 4);
    eocd64.writeUInt16LE(45, 12);
    eocd64.writeUInt16LE(45, 14);
    eocd64.writeBigUInt64LE(BigInt(central.length), 24);
    eocd64.writeBigUInt64LE(BigInt(central.length), 32);
    eocd64.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    eocd64.writeBigUInt64LE(BigInt(cdStart), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdStart + cdBuf.length), 8);
    locator.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    await write(Buffer.concat([cdBuf, eocd64, locator, eocd]));
    out.end();
  }
}
