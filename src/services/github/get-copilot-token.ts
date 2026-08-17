import { githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const response = await fetch(
    `${state.githubApiBaseUrl}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    },
  )

  if (!response.ok) throw new HTTPError("Failed to get Copilot token", response)

  return (await response.json()) as GetCopilotTokenResponse
}

interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  endpoints?: {
    api?: string
    proxy?: string
    "origin-tracker"?: string
    telemetry?: string
  }
}
