import { ChunkHeaderVersionSizes } from "../../enums/ChunkHeaderVersionSizes";
import { EChunkStorageFlags } from "../../enums/EChunkStorageFlags";
import { EChunkLoadResult } from "../../enums/EChunkLoadResult";
import { EChunkHashFlags } from "../../enums/EChunkHashFlags";
import { EChunkVersion } from "../../enums/EChunkVersion";

import { FRollingHash } from "../misc/FRollingHash";
import { FArchive } from "../misc/FArchive";
import { FSHAHash } from "../misc/FSHAHash";
import { toHex } from "../misc/HexUtils";
import { FGuid } from "../misc/FGuid";

import crypto from "crypto";
import zlib from "zlib";

export class FChunkHeader {
  /* The chunk header magic codeword, for quick checking that the opened file is a chunk file. */
  static readonly MAGIC: number = 0xB1FE3AA2


  /* The version of this header data. */
  Version: EChunkVersion = EChunkVersion.Latest
  /* The size of this header. */
  HeaderSize: number = ChunkHeaderVersionSizes[EChunkVersion.Latest]
  /* The GUID for this data. */
  Guid: FGuid
  /* The size of this data compressed. */
  DataSizeCompressed: number = 0
  /* The size of this data uncompressed. */
  DataSizeUncompressed: number = 1024 * 1024
  /* How the chunk data is stored. */
  StoredAs: EChunkStorageFlags = EChunkStorageFlags.None
  /* What type of hash we are using. */
  HashType: EChunkHashFlags = EChunkHashFlags.RollingPoly64
  /* The FRollingHash hashed value for this chunk data. */
  RollingHash: bigint = 0n
  /* The FSHA hashed value for this chunk data. */
  SHAHash: FSHAHash

  constructor(ar: FArchive, lazy: boolean) {
    /* Calculate how much space left in the archive for reading data ( will be 0 when writing ). */
    let startPos = ar.tell()
    let sizeLeft = ar.size - startPos
    let expectedBytes = 0

    /* Make sure the archive has enough data to read from, or we are saving instead. */
    let bSuccess = sizeLeft >= ChunkHeaderVersionSizes[EChunkVersion.Original]
    if (bSuccess) {
      let magic = ar.readUInt32()
      this.Version = ar.readUInt32()
      this.HeaderSize = ar.readUInt32()
      this.DataSizeCompressed = ar.readUInt32()
      this.Guid = new FGuid(ar)
      if (lazy) {
        ar.skip(8)
      }
      else {
        this.RollingHash = ar.readUInt64()
      }
      this.StoredAs = ar.readUInt8()

      bSuccess = magic === FChunkHeader.MAGIC
      expectedBytes = ChunkHeaderVersionSizes[EChunkVersion.Original]

      /* From version 2, we have a hash type choice. Previous versions default as only rolling. */
      if (bSuccess && this.Version >= EChunkVersion.StoresShaAndHashType) {
        bSuccess = sizeLeft >= ChunkHeaderVersionSizes[EChunkVersion.StoresShaAndHashType]
        if (bSuccess) {
          if (lazy) {
            ar.skip(FSHAHash.SIZE) // SHAHash
            ar.skip(1) // HashType
          }
          else {
            this.SHAHash = new FSHAHash(ar)
            this.HashType = ar.readUInt8()
          }
        }
        expectedBytes = ChunkHeaderVersionSizes[EChunkVersion.StoresShaAndHashType]
      }

      /* From version 3, we have an uncompressed data size. Previous versions default to 1 MiB (1048576 B). */
      if (bSuccess && this.Version >= EChunkVersion.StoresDataSizeUncompressed) {
        bSuccess = sizeLeft >= ChunkHeaderVersionSizes[EChunkVersion.StoresDataSizeUncompressed]
        if (bSuccess) {
          this.DataSizeUncompressed = ar.readUInt32()
        }
        expectedBytes = ChunkHeaderVersionSizes[EChunkVersion.StoresDataSizeUncompressed];
      }
    }

    /* Make sure the expected number of bytes were serialized. In practice this will catch errors where type */
    /* serialization operators changed their format and that will need investigating. */
    bSuccess = bSuccess && (ar.tell() - startPos) === expectedBytes
    if (bSuccess) {
      /* Make sure the archive now points to data location. Only seek if we must, to avoid a flush. */
      ar.seek(startPos + this.HeaderSize)
    }
    else {
      /* If we had a serialization error when loading, zero out the header values. */
      this.Version = EChunkVersion.Latest
      this.HeaderSize = ChunkHeaderVersionSizes[EChunkVersion.Latest]
      this.Guid = new FGuid()
      this.DataSizeCompressed = 0
      this.DataSizeUncompressed = 1024 * 1024
      this.StoredAs = EChunkStorageFlags.None
      this.HashType = EChunkHashFlags.RollingPoly64
      this.RollingHash = 0n
      this.SHAHash = new FSHAHash()
    }
  }

  load(ar: FArchive, lazy: boolean): [ EChunkLoadResult, Buffer ] {
    if (!this.Guid.isValid()) return [ EChunkLoadResult.CorruptHeader, null ]
    if (!lazy && this.HashType === EChunkHashFlags.None) return [ EChunkLoadResult.MissingHashInfo, null ]

    /* Begin of read pos. */
    let startPos = ar.tell()
    /* Available read size. */
    let sizeLeft = ar.size - startPos

    if (this.DataSizeCompressed > sizeLeft) return [ EChunkLoadResult.IncorrectFileSize, null ]
    if ((this.StoredAs & EChunkStorageFlags.Encrypted) == EChunkStorageFlags.Encrypted) return [ EChunkLoadResult.UnsupportedStorage, null ]

    /* Read the data. */
    let buf = ar.read(this.DataSizeCompressed)

    /* Decompress. */
    if ((this.StoredAs & EChunkStorageFlags.Compressed) == EChunkStorageFlags.Compressed) {
      let data = zlib.inflateSync(buf)
      if (data.length !== this.DataSizeUncompressed) return [ EChunkLoadResult.DecompressFailure, null ]
      buf = Buffer.alloc(this.DataSizeUncompressed)
      data.copy(buf)
    }

    /* Verify. */
    if (!lazy) {
      if ((this.HashType & EChunkHashFlags.RollingPoly64) == EChunkHashFlags.RollingPoly64) {
        let hash = FRollingHash.GetHashForDataSet(buf);
        if (toHex(hash) != toHex(this.RollingHash)) return [ EChunkLoadResult.HashCheckFailed, null ]
      }

      if ((this.HashType & EChunkHashFlags.Sha1) == EChunkHashFlags.Sha1) {
        let sha = crypto.createHash("sha1").update(buf).digest("hex").toUpperCase()
        if (sha != this.SHAHash.toString()) return [ EChunkLoadResult.HashCheckFailed, null ]
      }
    }

    return [ EChunkLoadResult.Success, buf ]
  }
}