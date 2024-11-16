import { Duplex } from "stream";

export class InMemoryDuplex extends Duplex {
  private chunks: Buffer[];
  private readIndex: number;

  constructor(options?: any) {
    super({ ...options, readableObjectMode: true, writableObjectMode: true });
    this.chunks = [];
    this.readIndex = 0;
  }

  _write(
    chunk: any,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, encoding);

    this.chunks.push(buffer);
    callback();
  }

  _read(size: number): void {
    while (this.readIndex < this.chunks.length) {
      const chunk = this.chunks[this.readIndex];
      this.readIndex++;

      if (!this.push(chunk)) {
        return;
      }
    }

    if (this.writableFinished) {
      this.push(null);
    }
  }

  end(): this;
  end(cb?: () => void): this;
  end(chunk: any, cb?: () => void): this;
  end(chunk: any, encoding?: BufferEncoding, cb?: () => void): this;
  end(chunk?: any, encoding?: any, cb?: any): this {
    return super.end(chunk, encoding, cb);
  }

  toString(encoding: BufferEncoding = "utf8"): string {
    return Buffer.concat(this.chunks).toString(encoding);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
