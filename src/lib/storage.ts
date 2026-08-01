export interface TransferRecord {
  id: string
  name: string
  size: number
  mimeType: string
  chunkSize: number
  receivedBytes: number
  updatedAt: number
  complete: boolean
}

interface ChunkRecord {
  fileId: string
  index: number
  data: ArrayBuffer
}

const DATABASE_NAME = 'airbridge-transfers'
const DATABASE_VERSION = 1
const TRANSFER_STORE = 'transfers'
const CHUNK_STORE = 'chunks'
const CHUNK_FILE_INDEX = 'by-file'

let databasePromise: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)

    request.addEventListener('upgradeneeded', () => {
      const database = request.result

      if (!database.objectStoreNames.contains(TRANSFER_STORE)) {
        database.createObjectStore(TRANSFER_STORE, { keyPath: 'id' })
      }

      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = database.createObjectStore(CHUNK_STORE, {
          keyPath: ['fileId', 'index'],
        })
        chunks.createIndex(CHUNK_FILE_INDEX, 'fileId', { unique: false })
      }
    })
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error ?? new Error('无法打开本地存储')))
  })

  return databasePromise
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error ?? new Error('本地存储操作失败')))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve())
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('本地存储事务被取消')))
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('本地存储事务失败')))
  })
}

export async function getTransfer(fileId: string): Promise<TransferRecord | undefined> {
  const database = await openDatabase()
  const transaction = database.transaction(TRANSFER_STORE, 'readonly')
  const record = await requestResult(
    transaction.objectStore(TRANSFER_STORE).get(fileId) as IDBRequest<TransferRecord | undefined>,
  )
  await transactionDone(transaction)
  return record
}

export async function ensureTransfer(
  incoming: Omit<TransferRecord, 'receivedBytes' | 'updatedAt' | 'complete'>,
): Promise<TransferRecord> {
  const existing = await getTransfer(incoming.id)

  if (
    existing &&
    existing.name === incoming.name &&
    existing.size === incoming.size &&
    existing.chunkSize === incoming.chunkSize
  ) {
    return existing
  }

  if (existing) await deleteTransfer(incoming.id)

  const record: TransferRecord = {
    ...incoming,
    receivedBytes: 0,
    updatedAt: Date.now(),
    complete: false,
  }
  const database = await openDatabase()
  const transaction = database.transaction(TRANSFER_STORE, 'readwrite')
  transaction.objectStore(TRANSFER_STORE).put(record)
  await transactionDone(transaction)
  return record
}

export async function saveChunk(
  transfer: TransferRecord,
  index: number,
  data: ArrayBuffer,
): Promise<TransferRecord> {
  const next: TransferRecord = {
    ...transfer,
    receivedBytes: Math.min(transfer.size, transfer.receivedBytes + data.byteLength),
    updatedAt: Date.now(),
    complete: transfer.receivedBytes + data.byteLength >= transfer.size,
  }
  const chunk: ChunkRecord = { fileId: transfer.id, index, data }
  const database = await openDatabase()
  const transaction = database.transaction([TRANSFER_STORE, CHUNK_STORE], 'readwrite')
  transaction.objectStore(CHUNK_STORE).put(chunk)
  transaction.objectStore(TRANSFER_STORE).put(next)
  await transactionDone(transaction)
  return next
}

export async function loadFileBlob(transfer: TransferRecord): Promise<Blob> {
  const database = await openDatabase()
  const transaction = database.transaction(CHUNK_STORE, 'readonly')
  const chunks = (await requestResult(
    transaction
      .objectStore(CHUNK_STORE)
      .index(CHUNK_FILE_INDEX)
      .getAll(IDBKeyRange.only(transfer.id)) as IDBRequest<ChunkRecord[]>,
  )).sort((left, right) => left.index - right.index)
  await transactionDone(transaction)

  return new Blob(
    chunks.map((chunk) => chunk.data),
    { type: transfer.mimeType || 'application/octet-stream' },
  )
}

export async function deleteTransfer(fileId: string): Promise<void> {
  const database = await openDatabase()
  const readTransaction = database.transaction(CHUNK_STORE, 'readonly')
  const keys = await requestResult(
    readTransaction
      .objectStore(CHUNK_STORE)
      .index(CHUNK_FILE_INDEX)
      .getAllKeys(IDBKeyRange.only(fileId)),
  )
  await transactionDone(readTransaction)

  const transaction = database.transaction([TRANSFER_STORE, CHUNK_STORE], 'readwrite')
  transaction.objectStore(TRANSFER_STORE).delete(fileId)
  const chunkStore = transaction.objectStore(CHUNK_STORE)
  keys.forEach((key) => chunkStore.delete(key))
  await transactionDone(transaction)
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  return navigator.storage.persist()
}

export async function availableStorage(): Promise<number | undefined> {
  if (!navigator.storage?.estimate) return undefined
  const estimate = await navigator.storage.estimate()
  if (estimate.quota === undefined || estimate.usage === undefined) return undefined
  return Math.max(0, estimate.quota - estimate.usage)
}
