import consola from "consola"
import { createHash } from "node:crypto"

import type {
  ResponsesApiRequest,
  ResponsesInputItem,
} from "~/routes/responses/types"

const ENCRYPTED_OUTPUT_ERROR =
  "Encrypted function output content could not be decrypted or decoded."
const MAX_REJECTED_ENCRYPTED_OUTPUTS = 256
const REJECTED_ENCRYPTED_OUTPUT_TTL_MS = 30 * 60 * 1000
const STREAM_FAILURE_INSPECTION_TIMEOUT_MS = 100
const MAX_STREAM_FAILURE_INSPECTION_BYTES = 64 * 1024
const MAX_STREAM_FAILURE_INSPECTION_EVENTS = 8
const rejectedEncryptedOutputs = new Map<string, number>()

export function createEncryptedOutputScope(
  url: string,
  model: string,
  accountIdentity: string,
): string {
  return fingerprintEncryptedOutput(`${url}\0${model}\0${accountIdentity}`)
}

export function isEncryptedOutputError(
  response: Response,
  errorBody: string,
): boolean {
  return response.status === 400 && errorBody.includes(ENCRYPTED_OUTPUT_ERROR)
}

export async function isImmediateEncryptedOutputStreamFailure(
  response: Response,
): Promise<boolean> {
  if (!response.body) return false
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return false
  }

  const reader = response.clone().body?.getReader()
  if (!reader) return false

  try {
    return await readImmediateEncryptedOutputStreamFailure(reader)
  } catch (error) {
    consola.debug("Failed to inspect Copilot Responses stream:", error)
  } finally {
    void reader.cancel().catch(() => undefined)
  }

  return false
}

export function stripEncryptedOutputParts(
  payload: ResponsesApiRequest,
  selected?: (fingerprint: string) => boolean,
): {
  count: number
  fingerprints: Array<string>
  payload: ResponsesApiRequest
} {
  if (typeof payload.input === "string") {
    return { count: 0, fingerprints: [], payload }
  }

  let count = 0
  const fingerprints: Array<string> = []
  let input: Array<ResponsesInputItem> | undefined
  for (const [index, item] of payload.input.entries()) {
    if (!Array.isArray(item.content)) continue
    const hasReadableText = item.content.some(
      (part) =>
        (part.type === "input_text" || part.type === "output_text")
        && typeof part.text === "string",
    )
    if (!hasReadableText) continue

    const content = item.content.filter((part) => {
      if (
        part.type !== "encrypted_content"
        || typeof part.encrypted_content !== "string"
      ) {
        return true
      }
      const fingerprint = fingerprintEncryptedOutput(part.encrypted_content)
      if (selected && !selected(fingerprint)) return true
      fingerprints.push(fingerprint)
      return false
    })
    if (content.length === item.content.length || content.length === 0) continue

    count += item.content.length - content.length
    input ??= [...payload.input]
    input[index] = { ...item, content }
  }

  return {
    count,
    fingerprints,
    payload: input ? { ...payload, input } : payload,
  }
}

export function isRejectedEncryptedOutput(
  scope: string,
  fingerprint: string,
): boolean {
  const key = rejectedEncryptedOutputKey(scope, fingerprint)
  const expiresAt = rejectedEncryptedOutputs.get(key)
  if (!expiresAt) return false
  if (expiresAt > Date.now()) return true

  rejectedEncryptedOutputs.delete(key)
  return false
}

export function rememberRejectedEncryptedOutputs(
  scope: string,
  fingerprints: Array<string>,
): void {
  if (fingerprints.length !== 1) return

  const key = rejectedEncryptedOutputKey(scope, fingerprints[0])
  rejectedEncryptedOutputs.delete(key)
  rejectedEncryptedOutputs.set(
    key,
    Date.now() + REJECTED_ENCRYPTED_OUTPUT_TTL_MS,
  )
  while (rejectedEncryptedOutputs.size > MAX_REJECTED_ENCRYPTED_OUTPUTS) {
    const oldest = rejectedEncryptedOutputs.keys().next().value
    if (!oldest) break
    rejectedEncryptedOutputs.delete(oldest)
  }
}

async function readImmediateEncryptedOutputStreamFailure(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
): Promise<boolean> {
  const decoder = new TextDecoder()
  const deadline = performance.now() + STREAM_FAILURE_INSPECTION_TIMEOUT_MS
  let buffer = ""
  let bytesRead = 0
  let eventsRead = 0

  while (true) {
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) return false

    const result = await readStreamChunkWithTimeout(reader, remainingMs)
    if (!result) return false

    const { done, value } = result
    if (value) {
      bytesRead += value.byteLength
      if (bytesRead > MAX_STREAM_FAILURE_INSPECTION_BYTES) return false
      buffer += decoder.decode(value, { stream: !done })
    } else if (done) {
      buffer += decoder.decode()
    }

    while (true) {
      const next = takeNextSseBlock(buffer)
      if (!next) break
      buffer = next.remaining
      const event = parseResponseEvent(next.block)
      if (!event) continue

      eventsRead++
      if (isEncryptedOutputFailureEvent(event)) return true
      if (!isProvisionalResponseEvent(event)) return false
      if (eventsRead >= MAX_STREAM_FAILURE_INSPECTION_EVENTS) return false
    }

    if (done) {
      const event = parseResponseEvent(buffer)
      return event ? isEncryptedOutputFailureEvent(event) : false
    }
  }
}

async function readStreamChunkWithTimeout(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read">,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | undefined> {
  return await Promise.race([
    reader.read(),
    new Promise<undefined>((resolve) => {
      setTimeout(resolve, timeoutMs)
    }),
  ])
}

function takeNextSseBlock(
  buffer: string,
): { block: string; remaining: string } | undefined {
  const boundary = /\r\n\r\n|\r\r|\n\n/.exec(buffer)
  if (boundary?.index === undefined) return undefined

  return {
    block: buffer.slice(0, boundary.index),
    remaining: buffer.slice(boundary.index + boundary[0].length),
  }
}

interface ResponseStreamEvent {
  type?: unknown
  [key: string]: unknown
}

function parseResponseEvent(block: string): ResponseStreamEvent | undefined {
  const data = block
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
  if (!data || data === "[DONE]") return undefined

  try {
    const event = JSON.parse(data) as unknown
    return event && typeof event === "object" ?
        (event as ResponseStreamEvent)
      : undefined
  } catch {
    return undefined
  }
}

function isEncryptedOutputFailureEvent(event: ResponseStreamEvent): boolean {
  return (
    event.type === "response.failed"
    && JSON.stringify(event).includes(ENCRYPTED_OUTPUT_ERROR)
  )
}

function isProvisionalResponseEvent(event: ResponseStreamEvent): boolean {
  return (
    event.type === "response.created" || event.type === "response.in_progress"
  )
}

function fingerprintEncryptedOutput(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function rejectedEncryptedOutputKey(
  scope: string,
  fingerprint: string,
): string {
  return `${scope}:${fingerprint}`
}
