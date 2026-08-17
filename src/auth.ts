#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { PATHS, ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
  githubBaseUrl?: string
  githubApiBaseUrl?: string
  githubClientId?: string
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  if (options.githubBaseUrl) state.githubBaseUrl = options.githubBaseUrl
  if (options.githubApiBaseUrl)
    state.githubApiBaseUrl = options.githubApiBaseUrl
  if (options.githubClientId) state.githubClientId = options.githubClientId

  if (state.githubBaseUrl !== "https://github.com") {
    consola.info(`Using GitHub Enterprise: ${state.githubBaseUrl}`)
  }

  state.showToken = options.showToken

  await ensurePaths()
  await setupGitHubToken({ force: true })
  consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub auth flow without running the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token on auth",
    },
    "github-url": {
      type: "string",
      description:
        "GitHub base URL for GHES (default: https://github.com). Also reads GITHUB_BASE_URL env var",
    },
    "github-api-url": {
      type: "string",
      description:
        "GitHub API base URL for GHES (default: https://api.github.com). Also reads GITHUB_API_BASE_URL env var",
    },
    "github-client-id": {
      type: "string",
      description:
        "OAuth App Client ID for GHES (default: Copilot's github.com client). Also reads GITHUB_CLIENT_ID env var",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
      githubBaseUrl:
        args["github-url"] || process.env.GITHUB_BASE_URL || undefined,
      githubApiBaseUrl:
        args["github-api-url"] || process.env.GITHUB_API_BASE_URL || undefined,
      githubClientId:
        args["github-client-id"] || process.env.GITHUB_CLIENT_ID || undefined,
    })
  },
})
