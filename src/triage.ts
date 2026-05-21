/**
 * Keyword-based subagent scoring engine.
 *
 * Scoring strategy (no LLM, pure text matching):
 * 1. Split query into words (min 2 chars, strip punctuation)
 * 2. For each subagent, score against name, description, and MCP server names
 * 3. Word boundary match > substring match (15 vs 10 base points)
 * 4. Name and MCP matches weighted 3x, description weighted 1x
 *
 * Threshold (30): minimum score gap between 1st and 2nd place for auto-routing.
 * If gap < threshold, we show multiple options instead of picking one.
 *
 * Why these weights:
 * - NAME_WEIGHT=3: subagent name is the strongest signal ("github" in query → github agent)
 * - DESC_WEIGHT=1: description is broader, more false positives
 * - MCP names use NAME_WEIGHT: server name matches are as strong as agent name matches
 */

import type { Subagent, ScoredSubagent } from "./types.js"
import { escapeRegex } from "./utils.js"

/** Minimum score gap between top two candidates for confident routing */
export const THRESHOLD = 30
/** Words shorter than this are ignored (too generic) */
const MIN_WORD_LENGTH = 2
/** Multiplier for name and MCP server matches */
const NAME_WEIGHT = 3
/** Multiplier for description matches (lower — more noise) */
const DESC_WEIGHT = 1

const wordRegexCache = new Map<string, RegExp>()

function getWordBonus(word: string, target: string): number {
  let re = wordRegexCache.get(word)
  if (!re) {
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, "iu")
    wordRegexCache.set(word, re)
  }
  if (re.test(target)) return 15
  if (target.includes(word)) return 10
  return 0
}

/**
 * Scores all subagents against a triage query.
 *
 * Scoring happens in three passes:
 * 1. Query words vs subagent name (highest weight)
 * 2. Query words vs subagent description (lower weight)
 * 3. Query words vs MCP server names assigned to the subagent (highest weight)
 *
 * Uses a Set for matchedBy to avoid duplicate entries when multiple
 * query words match the same MCP server.
 *
 * Returns only subagents with score > 0.
 */
export function scoreSubagents(
  query: string,
  subagents: Subagent[]
): ScoredSubagent[] {
  // Normalize query: lowercase, split on whitespace/punctuation, dedupe, strip punctuation, filter short words
  const words = [...new Set(
    query
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter((w) => w.length >= MIN_WORD_LENGTH)
  )]

  if (words.length === 0) return []

  return subagents.map((subagent) => {
    const nameLower = subagent.name.toLowerCase()
    const descLower = subagent.description.toLowerCase()
    const mcpNames = subagent.mcpServers.map((s) => s.toLowerCase())
    let score = 0
    // Use Set to deduplicate — multiple query words can match the same MCP server
    const matched = new Set<string>()

    // Pass 1: score against subagent name (strongest signal)
    for (const word of words) {
      const bonus = getWordBonus(word, nameLower)
      if (bonus > 0) {
        score += NAME_WEIGHT * bonus
        matched.add(`name:${word}`)
      }
    }

    // Pass 2: score against description (broader, more noise)
    for (const word of words) {
      const bonus = getWordBonus(word, descLower)
      if (bonus > 0) {
        score += DESC_WEIGHT * bonus
        matched.add(`desc:${word}`)
      }
    }

    // Pass 3: score against MCP server names assigned to this subagent
    // Treats MCP name matches as strong as name matches
    for (const mcpName of mcpNames) {
      for (const word of words) {
        const bonus = getWordBonus(word, mcpName)
        if (bonus > 0) {
          score += NAME_WEIGHT * bonus
          matched.add(`mcp:${mcpName}:${word}`)
        }
      }
    }

    return { subagent, score, matchedBy: Array.from(matched) }
    })
    .filter((s) => s.score > 0)
}
