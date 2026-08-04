import { afterEach, expect, mock, test } from "bun:test"

import type { ResponsesApiRequest } from "~/routes/responses/types"

import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"
state.models = {
  object: "list",
  data: [
    {
      id: "gpt-5.5",
      object: "model",
      name: "GPT 5.5",
      model_picker_enabled: true,
      preview: false,
      vendor: "openai",
      version: "1",
      capabilities: {
        family: "gpt-5.5",
        limits: {
          max_context_window_tokens: 400_000,
          max_output_tokens: 16_000,
          max_prompt_tokens: 272_000,
        },
        object: "model_capabilities",
        supports: {},
        tokenizer: "o200k_base",
        type: "chat",
      },
    },
  ],
}

afterEach(() => {
  mock.restore()
})

function bodyToString(body: unknown): string {
  if (typeof body !== "string") {
    throw new TypeError("expected fetch body to be a string")
  }
  return body
}

test("retries without encrypted output parts Copilot cannot decrypt", async () => {
  const payload = {
    model: "gpt-5.5",
    input: [
      {
        type: "reasoning",
        encrypted_content: "valid-reasoning-ciphertext",
        summary: [],
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Message Type: MESSAGE" },
          {
            type: "encrypted_content",
            encrypted_content: "stale-output-ciphertext",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "encrypted_content",
            encrypted_content: "encrypted-only-content",
          },
        ],
      },
    ],
  } as unknown as ResponsesApiRequest

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    const hasEncryptedOutput = body.includes("stale-output-ciphertext")
    return new Response(
      JSON.stringify(
        hasEncryptedOutput ?
          {
            error: {
              message:
                "Encrypted function output content could not be decrypted or decoded.",
              code: "invalid_request_body",
            },
          }
        : { id: "resp_encrypted_output_recovered" },
      ),
      {
        status: hasEncryptedOutput ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const retryBody = bodyToString(fetchMock.mock.calls[1][1].body)

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(retryBody).not.toContain("stale-output-ciphertext")
  expect(retryBody).toContain("valid-reasoning-ciphertext")
  expect(retryBody).toContain("encrypted-only-content")
  expect(retryBody).toContain("Message Type: MESSAGE")

  await createResponses(payload)
  const nextBody = bodyToString(fetchMock.mock.calls[2][1].body)

  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(nextBody).not.toContain("stale-output-ciphertext")

  await createResponses({ ...payload, model: "gpt-5.6" })
  const otherModelBody = bodyToString(fetchMock.mock.calls[3][1].body)
  const otherModelRetryBody = bodyToString(fetchMock.mock.calls[4][1].body)

  expect(fetchMock).toHaveBeenCalledTimes(5)
  expect(otherModelBody).toContain("stale-output-ciphertext")
  expect(otherModelRetryBody).not.toContain("stale-output-ciphertext")
})

test("does not cache every encrypted output when a request has several", async () => {
  const payload = {
    model: "gpt-5.5",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Continue" },
          {
            type: "encrypted_content",
            encrypted_content: "possibly-stale-ciphertext-a",
          },
          {
            type: "encrypted_content",
            encrypted_content: "possibly-stale-ciphertext-b",
          },
        ],
      },
    ],
  } as unknown as ResponsesApiRequest

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    const hasEncryptedOutput = body.includes("possibly-stale-ciphertext")
    return new Response(
      JSON.stringify(
        hasEncryptedOutput ?
          {
            error: {
              message:
                "Encrypted function output content could not be decrypted or decoded.",
            },
          }
        : { id: "resp_multiple_encrypted_outputs_recovered" },
      ),
      {
        status: hasEncryptedOutput ? 400 : 200,
        headers: { "content-type": "application/json" },
      },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  await createResponses(payload)
  await createResponses(payload)

  const nextInitialBody = bodyToString(fetchMock.mock.calls[2][1].body)
  expect(fetchMock).toHaveBeenCalledTimes(4)
  expect(nextInitialBody).toContain("possibly-stale-ciphertext-a")
  expect(nextInitialBody).toContain("possibly-stale-ciphertext-b")
})

test("retries an immediate failed stream without stale encrypted outputs", async () => {
  const payload = {
    model: "gpt-5.5",
    stream: true,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Message Type: MESSAGE" },
          {
            type: "encrypted_content",
            encrypted_content: "stale-stream-ciphertext",
          },
        ],
      },
    ],
  } as unknown as ResponsesApiRequest

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    const stale = body.includes("stale-stream-ciphertext")
    const events =
      stale ?
        [
          { type: "response.created", response: { status: "in_progress" } },
          {
            type: "response.failed",
            response: {
              status: "failed",
              error: {
                code: "invalid_request_body",
                message:
                  "Encrypted function output content could not be decrypted or decoded.",
              },
            },
          },
        ]
      : [
          { type: "response.created", response: { status: "in_progress" } },
          { type: "response.output_text.delta", delta: "OK" },
          { type: "response.completed", response: { status: "completed" } },
        ]

    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)
  const responseBody = await response.text()
  const retryBody = bodyToString(fetchMock.mock.calls[1][1].body)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(retryBody).not.toContain("stale-stream-ciphertext")
  expect(responseBody).toContain("response.output_text.delta")
  expect(responseBody).toContain("response.completed")
  expect(responseBody).not.toContain("response.failed")
})

test("does not retry or cache unrelated immediate stream failures", async () => {
  const payload = {
    model: "gpt-5.5",
    stream: true,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Message Type: MESSAGE" },
          {
            type: "encrypted_content",
            encrypted_content: "valid-generic-failure-ciphertext",
          },
        ],
      },
    ],
  } as unknown as ResponsesApiRequest

  let call = 0
  const fetchMock = mock((_url: string, _opts: RequestInit) => {
    const currentCall = call++
    const events =
      currentCall === 0 ?
        [
          { type: "response.created", response: { status: "in_progress" } },
          {
            type: "response.failed",
            response: {
              status: "failed",
              error: { code: "server_error", message: "Upstream overloaded" },
            },
          },
        ]
      : [
          { type: "response.created", response: { status: "in_progress" } },
          { type: "response.output_text.delta", delta: "OK" },
          { type: "response.completed", response: { status: "completed" } },
        ]

    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const failed = await createResponses(payload)
  expect(await failed.text()).toContain("server_error")
  expect(fetchMock).toHaveBeenCalledTimes(1)

  await createResponses(payload)
  const nextBody = bodyToString(fetchMock.mock.calls[1][1].body)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(nextBody).toContain("valid-generic-failure-ciphertext")
})

test("detects encrypted-output failures across split CRLF boundaries", async () => {
  const payload = {
    model: "gpt-5.5",
    stream: true,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Continue" },
          {
            type: "encrypted_content",
            encrypted_content: "stale-split-crlf-ciphertext",
          },
        ],
      },
    ],
  } as unknown as ResponsesApiRequest
  const encoder = new TextEncoder()

  const fetchMock = mock((_url: string, opts: RequestInit) => {
    const body = bodyToString(opts.body)
    if (!body.includes("stale-split-crlf-ciphertext")) {
      return new Response(
        `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      )
    }

    const events = [
      { type: "response.created", response: { status: "in_progress" } },
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: {
            code: "invalid_request_body",
            message:
              "Encrypted function output content could not be decrypted or decoded.",
          },
        },
      },
    ]
    const serialized = events
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("")
    const chunks: Array<string> = []
    let start = 0
    for (let index = 0; index < serialized.length; index++) {
      if (serialized[index] !== "\r") continue
      chunks.push(serialized.slice(start, index + 1))
      start = index + 1
    }
    chunks.push(serialized.slice(start))

    return new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
          controller.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)

  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(await response.text()).toContain("response.completed")
})

test("bounds encrypted-output inspection while a valid stream is idle", async () => {
  const payload = {
    model: "gpt-5.5",
    stream: true,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Continue" },
          {
            type: "encrypted_content",
            encrypted_content: "valid-slow-stream-ciphertext",
          },
        ],
      },
    ],
  } as unknown as ResponsesApiRequest
  const encoder = new TextEncoder()
  const fetchMock = mock(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "response.created" })}\n\n`,
              ),
            )
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "OK" })}\n\n`,
                ),
              )
              controller.close()
            }, 350)
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const startedAt = performance.now()
  const response = await createResponses(payload)
  const elapsed = performance.now() - startedAt

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(elapsed).toBeLessThan(250)
  expect(await response.text()).toContain("response.output_text.delta")
})

test("does not retry after a Responses stream starts model output", async () => {
  const payload = {
    model: "gpt-5.5",
    stream: true,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Message Type: MESSAGE" },
          {
            type: "encrypted_content",
            encrypted_content: "valid-stream-ciphertext",
          },
        ],
      },
    ],
  } as unknown as ResponsesApiRequest
  const streamBody = [
    { type: "response.created", response: { status: "in_progress" } },
    { type: "response.output_text.delta", delta: "OK" },
    { type: "response.completed", response: { status: "completed" } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")
  const fetchMock = mock(
    () =>
      new Response(streamBody, {
        headers: { "content-type": "text/event-stream" },
      }),
  )
  globalThis.fetch = fetchMock as unknown as typeof fetch

  const response = await createResponses(payload)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(await response.text()).toBe(streamBody)
})
