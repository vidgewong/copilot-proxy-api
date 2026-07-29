import consola from "consola"

import type {
  ResponsesApiRequest,
  ResponsesContentPart,
  ResponsesInputItem,
} from "~/routes/responses/types"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { copilotFetch } from "~/lib/copilot-fetch"
import { HTTPError } from "~/lib/error"
import {
  getKnownModelPromptLimit,
  getModelPromptLimit,
} from "~/lib/model-limits"
import { state } from "~/lib/state"

const MAX_RESPONSES_PAYLOAD_BYTES = 5_000_000
const CHARS_PER_TOKEN_ESTIMATE = 3.5
const TOKEN_RESERVE = 8_000
const IMAGE_STRIPPED_PLACEHOLDER =
  "[image removed to stay under upstream payload limit]"
const INVALID_OUTPUT_IMAGE_PLACEHOLDER =
  "[image output removed because its URL is not valid for Copilot Responses]"
const ENCRYPTED_OUTPUT_ERROR =
  "Encrypted function output content could not be decrypted or decoded."
const INPUT_DROPPED_PLACEHOLDER =
  "[older response input omitted to stay under context limit]"
const INPUT_TRUNCATED_PREFIX =
  "[older response input truncated to stay under context limit]\n\n"
const PRESERVED_INPUT_STRING_KEYS = new Set([
  "call_id",
  "id",
  "model",
  "name",
  "previous_response_id",
  "role",
  "status",
  "tool_call_id",
  "type",
])

export async function createResponses(
  payload: ResponsesApiRequest,
): Promise<Response> {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  let upstreamPayload = fitResponsesPayload(
    sanitizeResponsesPayload(payload),
    computeResponsesPayloadCeiling(payload.model),
  )
  let body = JSON.stringify(upstreamPayload)
  const headers: Record<string, string> = {
    ...copilotHeaders(state, responsesPayloadHasImages(upstreamPayload)),
    accept: upstreamPayload.stream ? "text/event-stream" : "application/json",
    "X-Initiator": "agent",
  }

  consola.info(
    `Sending responses payload: ${body.length} bytes, model: ${payload.model}`,
  )

  const url = `${copilotBaseUrl(state)}/responses`
  let response = await copilotFetch(url, {
    method: "POST",
    headers,
    body,
  })

  if (!response.ok) {
    let errorBody = await response.text()

    if (isEncryptedOutputError(response, errorBody)) {
      const sanitized = stripEncryptedOutputParts(upstreamPayload)
      if (sanitized.count > 0) {
        upstreamPayload = sanitized.payload
        body = JSON.stringify(upstreamPayload)
        consola.warn(
          `Copilot could not decrypt ${sanitized.count} encrypted output part(s); retrying without them`,
        )
        response = await copilotFetch(url, {
          method: "POST",
          headers,
          body,
        })
        if (response.ok) return response
        errorBody = await response.text()
      }
    }

    consola.error(
      `Failed to create responses - Status: ${response.status} ${response.statusText}`,
    )
    consola.error(`Response body: ${errorBody}`)
    consola.error(`Request payload size: ${body.length} bytes`)

    if (isContextOverflow(response, errorBody, body.length)) {
      const estimatedTokens = Math.ceil(body.length / 4)
      const modelCaps = state.models?.data.find((m) => m.id === payload.model)
        ?.capabilities.limits
      const modelLimit = getModelPromptLimit(payload.model, modelCaps)
      const maxOutputTokens = payload.max_output_tokens ?? 0

      consola.warn(
        `Responses context overflow -> returning 400 prompt-too-long (~${estimatedTokens} + ${maxOutputTokens} > ${modelLimit})`,
      )

      throw new HTTPError(
        "Prompt too long",
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `prompt is too long: input length and \`max_tokens\` exceed context limit: ${estimatedTokens} + ${maxOutputTokens} > ${modelLimit} tokens`,
            },
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "content-type": "application/json" },
          },
        ),
      )
    }

    throw new HTTPError(
      "Failed to create responses",
      new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }

  return response
}

function isEncryptedOutputError(
  response: Response,
  errorBody: string,
): boolean {
  return response.status === 400 && errorBody.includes(ENCRYPTED_OUTPUT_ERROR)
}

function stripEncryptedOutputParts(payload: ResponsesApiRequest): {
  count: number
  payload: ResponsesApiRequest
} {
  if (typeof payload.input === "string") return { count: 0, payload }

  let count = 0
  let input: Array<ResponsesInputItem> | undefined
  for (const [index, item] of payload.input.entries()) {
    if (!Array.isArray(item.content)) continue
    const hasReadableText = item.content.some(
      (part) =>
        (part.type === "input_text" || part.type === "output_text")
        && typeof part.text === "string",
    )
    if (!hasReadableText) continue

    const content = item.content.filter(
      (part) => part.type !== "encrypted_content",
    )
    if (content.length === item.content.length || content.length === 0) continue

    count += item.content.length - content.length
    input ??= [...payload.input]
    input[index] = { ...item, content }
  }

  return { count, payload: input ? { ...payload, input } : payload }
}

function fitResponsesPayload(
  payload: ResponsesApiRequest,
  ceiling: number,
): ResponsesApiRequest {
  const initialBody = JSON.stringify(payload)
  if (initialBody.length <= ceiling) return payload

  consola.info(
    `Responses context fit: payload ${initialBody.length} bytes exceeds ${ceiling} byte ceiling - reducing`,
  )

  if (typeof payload.input === "string") {
    const current = truncateStringInput(payload, ceiling)
    const currentBodyLength = JSON.stringify(current).length
    consola.warn(
      `Responses context fit: truncated string input (${initialBody.length} -> ${currentBodyLength} bytes)`,
    )
    return current
  }

  let current = payload
  let currentBodyLength = initialBody.length

  const imageLocations = collectImageLocations(payload)
  let strippedCount = 0

  for (const location of imageLocations) {
    current = replaceImageWithPlaceholder(current, location)
    strippedCount++
    currentBodyLength = JSON.stringify(current).length
    if (currentBodyLength <= ceiling) break
  }

  if (strippedCount > 0) {
    consola.warn(
      `Responses context fit: stripped ${strippedCount} images (${initialBody.length} -> ${currentBodyLength} bytes)`,
    )
  }

  if (currentBodyLength <= ceiling) return current

  const dropped = dropOldInputItems(current, ceiling)
  current = dropOrphanedToolCallOutputs(dropped.payload)
  currentBodyLength = JSON.stringify(current).length
  if (dropped.count > 0) {
    consola.warn(
      `Responses context fit: dropped ${dropped.count} old input items (${initialBody.length} -> ${currentBodyLength} bytes)`,
    )
  }

  if (currentBodyLength <= ceiling) return current

  current = truncateLargestInputContent(current, ceiling)
  currentBodyLength = JSON.stringify(current).length
  consola.warn(
    `Responses context fit: truncated input content (${initialBody.length} -> ${currentBodyLength} bytes)`,
  )

  if (currentBodyLength <= ceiling) return current

  current = minimizeResponsesInput(current, ceiling)
  currentBodyLength = JSON.stringify(current).length
  consola.warn(
    `Responses context fit: minimized input history (${initialBody.length} -> ${currentBodyLength} bytes)`,
  )

  if (currentBodyLength <= ceiling) return current

  current = truncateLargestPayloadStrings(current, ceiling)
  currentBodyLength = JSON.stringify(current).length
  consola.warn(
    `Responses context fit: truncated payload strings (${initialBody.length} -> ${currentBodyLength} bytes)`,
  )

  return current
}

function computeResponsesPayloadCeiling(modelId: string): number {
  const limits = state.models?.data.find((m) => m.id === modelId)?.capabilities
    .limits
  const maxPromptTokens = getKnownModelPromptLimit(modelId, limits)
  if (!maxPromptTokens) return MAX_RESPONSES_PAYLOAD_BYTES

  const tokenDerivedBytes = Math.floor(
    (maxPromptTokens - TOKEN_RESERVE) * CHARS_PER_TOKEN_ESTIMATE,
  )
  return Math.min(MAX_RESPONSES_PAYLOAD_BYTES, tokenDerivedBytes)
}

function truncateStringInput(
  payload: ResponsesApiRequest,
  ceiling: number,
): ResponsesApiRequest {
  if (typeof payload.input !== "string") return payload

  const overhead = JSON.stringify({ ...payload, input: "" }).length
  const maxInputLength = Math.max(
    INPUT_TRUNCATED_PREFIX.length,
    ceiling - overhead,
  )
  const tailLength = Math.max(0, maxInputLength - INPUT_TRUNCATED_PREFIX.length)
  return {
    ...payload,
    input: INPUT_TRUNCATED_PREFIX + payload.input.slice(-tailLength),
  }
}

interface ImageLocation {
  contentIndex: number
  inputIndex: number
}

function collectImageLocations(
  payload: ResponsesApiRequest,
): Array<ImageLocation> {
  if (typeof payload.input === "string") return []

  const locations: Array<ImageLocation> = []
  for (const [inputIndex, item] of payload.input.entries()) {
    if (!Array.isArray(item.content)) continue

    for (const [contentIndex, part] of item.content.entries()) {
      if (part.type === "input_image") {
        locations.push({ contentIndex, inputIndex })
      }
    }
  }
  return locations
}

function replaceImageWithPlaceholder(
  payload: ResponsesApiRequest,
  location: ImageLocation,
): ResponsesApiRequest {
  if (typeof payload.input === "string") return payload

  const input = [...payload.input]
  const item = input[location.inputIndex]
  if (!Array.isArray(item.content)) return payload

  const content = [...item.content]
  content[location.contentIndex] = {
    type: "input_text",
    text: IMAGE_STRIPPED_PLACEHOLDER,
  }

  input[location.inputIndex] = { ...item, content }
  return { ...payload, input }
}

function dropOldInputItems(
  payload: ResponsesApiRequest,
  ceiling: number,
): { bodyLength: number; count: number; payload: ResponsesApiRequest } {
  if (typeof payload.input === "string") {
    return { bodyLength: JSON.stringify(payload).length, count: 0, payload }
  }

  const input = [...payload.input]
  let bodyLength = JSON.stringify({ ...payload, input }).length
  let count = 0

  for (let index = 0; index < input.length && bodyLength > ceiling; index++) {
    const item = input[index]
    if (item.role === "system" || item.role === "developer") continue
    if (countRecentDroppableItems(input, index) <= 2) continue

    input[index] = createDroppedInputItem(item)
    count++
    bodyLength = JSON.stringify({ ...payload, input }).length
  }

  return { bodyLength, count, payload: { ...payload, input } }
}

function createDroppedInputItem(item: ResponsesInputItem): ResponsesInputItem {
  return {
    role: item.role === "assistant" ? "assistant" : "user",
    content: INPUT_DROPPED_PLACEHOLDER,
  }
}

function dropOrphanedToolCallOutputs(
  payload: ResponsesApiRequest,
): ResponsesApiRequest {
  if (typeof payload.input === "string") return payload

  const callIds = new Set(
    payload.input
      .filter((item) => isToolCallItem(item) && item.call_id)
      .map((item) => item.call_id),
  )
  let droppedCount = 0
  const input = payload.input.map((item) => {
    if (
      !isToolCallOutputItem(item)
      || !item.call_id
      || callIds.has(item.call_id)
    ) {
      return item
    }

    droppedCount++
    return createDroppedInputItem(item)
  })

  if (droppedCount === 0) return payload
  consola.warn(
    `Responses context fit: dropped ${droppedCount} orphaned tool call outputs`,
  )
  return { ...payload, input }
}

function isToolCallItem(item: ResponsesInputItem): boolean {
  return typeof item.type === "string" && item.type.endsWith("_call")
}

function isToolCallOutputItem(item: ResponsesInputItem): boolean {
  return typeof item.type === "string" && item.type.endsWith("_call_output")
}

function countRecentDroppableItems(
  input: Array<ResponsesInputItem>,
  index: number,
): number {
  let count = 0
  for (let i = index; i < input.length; i++) {
    if (input[i].role !== "system" && input[i].role !== "developer") count++
  }
  return count
}

function truncateLargestInputContent(
  payload: ResponsesApiRequest,
  ceiling: number,
): ResponsesApiRequest {
  if (typeof payload.input === "string") {
    return truncateStringInput(payload, ceiling)
  }

  let current = payload
  let bodyLength = JSON.stringify(current).length

  while (bodyLength > ceiling) {
    const target = findLargestInputString(current)
    if (!target) return current

    current = truncateStringAtLocation(current, target, bodyLength - ceiling)
    const nextBodyLength = JSON.stringify(current).length
    if (nextBodyLength >= bodyLength) return current
    bodyLength = nextBodyLength
  }

  return current
}

interface StringLocation {
  inputIndex: number
  length: number
  path: Array<number | string>
}

function findLargestInputString(
  payload: ResponsesApiRequest,
): StringLocation | null {
  if (typeof payload.input === "string") return null

  let largest: StringLocation | null = null
  for (const [inputIndex, item] of payload.input.entries()) {
    if (item.role === "system" || item.role === "developer") continue

    const candidate = findLargestStringInValue(item, [])
    if (candidate && (!largest || candidate.length > largest.length)) {
      largest = { inputIndex, ...candidate }
    }
  }

  return largest
}

function truncateStringAtLocation(
  payload: ResponsesApiRequest,
  location: StringLocation,
  excessBytes: number,
): ResponsesApiRequest {
  if (typeof payload.input === "string") return payload

  const input = [...payload.input]
  const item = input[location.inputIndex]
  const keepLength = Math.max(
    0,
    location.length - excessBytes - INPUT_TRUNCATED_PREFIX.length - 10_000,
  )

  input[location.inputIndex] = truncateStringAtPath(
    item,
    location.path,
    keepLength,
  ) as ResponsesInputItem
  return { ...payload, input }
}

interface StringCandidate {
  length: number
  path: Array<number | string>
}

function findLargestStringInValue(
  value: unknown,
  path: Array<number | string>,
): StringCandidate | null {
  if (typeof value === "string") {
    const key = path.at(-1)
    if (typeof key === "string" && PRESERVED_INPUT_STRING_KEYS.has(key)) {
      return null
    }
    return { length: value.length, path }
  }

  if (Array.isArray(value)) {
    return value.reduce<StringCandidate | null>((largest, item, index) => {
      const candidate = findLargestStringInValue(item, [...path, index])
      if (!candidate) return largest
      return !largest || candidate.length > largest.length ? candidate : largest
    }, null)
  }

  if (!isRecord(value)) return null

  let largest: StringCandidate | null = null
  for (const [key, nested] of Object.entries(value)) {
    const candidate = findLargestStringInValue(nested, [...path, key])
    if (candidate && (!largest || candidate.length > largest.length)) {
      largest = candidate
    }
  }
  return largest
}

function truncateStringAtPath(
  value: unknown,
  path: Array<number | string>,
  keepLength: number,
): unknown {
  if (path.length === 0) {
    if (typeof value !== "string") return value
    return INPUT_TRUNCATED_PREFIX + value.slice(-keepLength)
  }

  const [head, ...tail] = path
  if (Array.isArray(value) && typeof head === "number") {
    const arrayValue = value as Array<unknown>
    const next = [...arrayValue]
    next[head] = truncateStringAtPath(next[head], tail, keepLength)
    return next
  }

  if (isRecord(value) && typeof head === "string") {
    return {
      ...value,
      [head]: truncateStringAtPath(value[head], tail, keepLength),
    }
  }

  return value
}

function minimizeResponsesInput(
  payload: ResponsesApiRequest,
  ceiling: number,
): ResponsesApiRequest {
  if (typeof payload.input === "string") {
    return truncateStringInput(payload, ceiling)
  }

  const protectedItems = payload.input.filter(
    (item) => item.role === "system" || item.role === "developer",
  )
  const latest = [...payload.input]
    .reverse()
    .find((item) => item.role !== "system" && item.role !== "developer")

  return {
    ...payload,
    input: [
      ...protectedItems,
      {
        role: latest?.role === "assistant" ? "assistant" : "user",
        content: INPUT_DROPPED_PLACEHOLDER,
      },
    ],
  }
}

function truncateLargestPayloadStrings(
  payload: ResponsesApiRequest,
  ceiling: number,
): ResponsesApiRequest {
  let current = payload
  let bodyLength = JSON.stringify(current).length

  while (bodyLength > ceiling) {
    const target = findLargestStringInValue(current, [])
    if (!target) return current

    current = truncateStringAtPath(
      current,
      target.path,
      bodyLength - ceiling,
    ) as ResponsesApiRequest
    const nextBodyLength = JSON.stringify(current).length
    if (nextBodyLength >= bodyLength) return current
    bodyLength = nextBodyLength
  }

  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isContextOverflow(
  response: Response,
  errorBody: string,
  bodyLength: number,
): boolean {
  return (
    response.status === 413
    || /request entity too large/i.test(errorBody)
    || /exceeds the limit of \d+/i.test(errorBody)
    || /context_length_exceeded/i.test(errorBody)
    || /operation timed out/i.test(errorBody)
    || /payload too large/i.test(errorBody)
    || /maximum context length/i.test(errorBody)
    || (response.status >= 500
      && response.status < 600
      && bodyLength > 2_000_000)
  )
}

function sanitizeResponsesPayload(
  payload: ResponsesApiRequest,
): ResponsesApiRequest {
  const sanitized: ResponsesApiRequest = sanitizeInvalidOutputImages(payload)

  // Codex sends ChatGPT-only fast mode metadata; Copilot Responses rejects it.
  delete (sanitized as ResponsesApiRequest & { service_tier?: unknown })
    .service_tier

  if (!sanitized.tools?.some((tool) => tool.type === "image_generation")) {
    return sanitized
  }

  return {
    ...sanitized,
    tools: sanitized.tools.filter((tool) => tool.type !== "image_generation"),
  }
}

function sanitizeInvalidOutputImages(
  payload: ResponsesApiRequest,
): ResponsesApiRequest {
  if (typeof payload.input === "string") return payload

  let input: Array<ResponsesInputItem> | undefined
  for (const [index, item] of payload.input.entries()) {
    if (!Array.isArray(item.output)) continue

    const sanitizedOutput = sanitizeOutputParts(item.output)
    if (sanitizedOutput === item.output) continue

    input ??= [...payload.input]
    input[index] = { ...item, output: sanitizedOutput }
  }

  return input ? { ...payload, input } : payload
}

function sanitizeOutputParts(
  output: NonNullable<ResponsesInputItem["output"]>,
): ResponsesInputItem["output"] {
  if (typeof output === "string") return output

  const sanitizedOutput = output.map((part) => sanitizeOutputPart(part))
  const changed = sanitizedOutput.some((part, index) => part !== output[index])

  return changed ? sanitizedOutput : output
}

function sanitizeOutputPart(part: ResponsesContentPart): ResponsesContentPart {
  if (hasInvalidImageUrl(part)) {
    return {
      type: "input_text",
      text: INVALID_OUTPUT_IMAGE_PLACEHOLDER,
    }
  }

  if (typeof part.image_url === "string" && part.type !== "input_image") {
    return {
      type: "input_image",
      image_url: part.image_url,
      detail: part.detail,
    }
  }

  if (part.type === "output_text") {
    return {
      type: "input_text",
      text: part.text ?? "",
    }
  }

  return part
}

function hasInvalidImageUrl(part: { image_url?: unknown }): boolean {
  if (
    !("image_url" in part)
    || part.image_url === null
    || part.image_url === undefined
  ) {
    return false
  }
  return typeof part.image_url !== "string" || !isValidHttpUrl(part.image_url)
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function responsesPayloadHasImages(payload: ResponsesApiRequest): boolean {
  if (typeof payload.input === "string") return false

  return payload.input.some(
    (item) =>
      Array.isArray(item.content)
      && item.content.some((part) => part.type === "input_image"),
  )
}
