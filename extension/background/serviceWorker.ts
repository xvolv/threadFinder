// Minimal MV3 service worker
// Listens for install/activate and can be extended later

chrome.runtime.onInstalled.addListener(() => {
  // Initialization logic can go here
  console.log('ThreadFinder service worker installed')
})

chrome.runtime.onStartup?.addListener(() => {
  console.log('ThreadFinder service worker started')
})

// Example context menu setup (safe placeholder)
try {
  chrome.runtime.onInstalled.addListener(() => {
    if (chrome.contextMenus) {
      chrome.contextMenus.create({
        id: 'threadfinder-search',
        title: 'Search discussions for "%s"',
        contexts: ['selection'],
      })
    }
  })

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'threadfinder-search' && info.selectionText) {
      const term = info.selectionText.trim()
      if (!term) return
      if (tab?.id) {
        chrome.tabs.sendMessage(
          tab.id,
          { type: 'threadfinder:search', term },
          undefined as any,
          () => {
            // Ignore if no receiver (e.g., restricted pages where content scripts cannot run)
            void (chrome.runtime as any).lastError
          }
        )
      }
    }
  })
} catch (e) {
  // In case permissions or APIs are unavailable during development
  console.warn('Context menus not available:', e)
}

// Handle cross-origin fetches (e.g., Reddit, Gemini) from the background to avoid page CORS/CSP issues
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'threadfinder:fetchReddit' && typeof msg.term === 'string') {
    (async () => {
      try {
        const rows = await redditFetchCached(msg.term)
        ;(sendResponse as any)({ ok: true, items: rows })
      } catch (err) {
        console.error('Reddit fetch failed:', err)
        ;(sendResponse as any)({ ok: false, error: String(err) })
      }
    })()
    // Keep the message channel open for async response
    return true
  } 
  
  // Handle Gemini API requests
  if (msg && msg.type === 'threadfinder:gemini' && typeof msg.prompt === 'string') {
    (async () => {
      try {
        const result = await handleGeminiRequest(msg.prompt, msg.context || '');
        (sendResponse as any)({ text: result });
      } catch (error) {
        console.error('Gemini API error:', error);
        (sendResponse as any)({ 
          error: error.message || 'Failed to get response from Gemini',
          details: (error as any).details
        });
      }
    })();
    return true; // Keep the message channel open for async response
  }
  
  return false;
})

// Cache the first working Gemini endpoint+model for this SW lifetime
let geminiResolvedEndpoint: { base: 'v1' | 'v1beta'; model: string } | null = null

function fetchWithTimeout(resource: string, options: RequestInit, timeoutMs = 60000): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const id = setTimeout(() => controller.abort(), timeoutMs)
    fetch(resource, { ...options, signal: controller.signal })
      .then((res) => {
        clearTimeout(id)
        resolve(res)
      })
      .catch((err) => {
        clearTimeout(id)
        if ((err as any)?.name === 'AbortError') {
          reject(new Error('Gemini request timed out'))
        } else {
          reject(err)
        }
      })
  })
}

function extractGeminiText(resp: any): string {
  try {
    const candidates = Array.isArray(resp?.candidates) ? resp.candidates : []
    for (const cand of candidates) {
      const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : []
      const texts = parts
        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
        .filter((t: string) => t)
      if (texts.length) return texts.join('\n')
    }
    return ''
  } catch {
    return ''
  }
}

async function handleGeminiRequest(prompt: string, context: string = ''): Promise<string> {
  // Get the API key from storage
  const result = await chrome.storage.sync.get('GEMINI_API_KEY');
  const apiKey = result.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error('Gemini API key not found. Please set it in the extension options.');
  }

  // Prepare request body
  const body = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: 'Provide a concise, plain-text answer. Do not include reasoning steps. Limit to a short paragraph.' }],
    },
    contents: [{
      role: 'user',
      parts: [{
        text: `${prompt}\n\nContext:\n${context || 'No additional context provided.'}`
      }],
    }],
    generationConfig: {
      temperature: 0.4,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 1024,
      responseMimeType: 'text/plain',
    },
  };

  // Try preferred model first, then fallbacks (order matters)
  // Some API keys/projects only expose a subset of models and sometimes only on v1beta.
  const models = ['gemini-2.5-pro', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro', 'gemini-pro']
  const bases: Array<'v1' | 'v1beta'> = ['v1beta', 'v1']

  // Fast preflight: check reachability and key validity quickly to avoid long timeouts
  try {
    await fetchWithTimeout(
      'https://generativelanguage.googleapis.com/v1beta/models',
      { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
      5000
    )
  } catch (e: any) {
    const err = new Error('Unable to reach generativelanguage.googleapis.com (preflight). Possible network/VPN/firewall/adblock issue or invalid API key.')
    ;(err as any).details = { stage: 'preflight_listmodels_v1beta', original: String(e?.message || e) }
    throw err
  }

  let lastErr: any = null;
  // Hard-prefer a fast model first (v1beta/gemini-1.5-flash), then others
  {
    const base: 'v1beta' = 'v1beta'
    const model = 'gemini-1.5-flash'
    const apiUrl = `https://generativelanguage.googleapis.com/${base}/models/${model}:generateContent`
    try {
      console.log('[Gemini] try', { base, model })
      console.time(`[Gemini] ${base}/${model}`)
      const response = await fetchWithTimeout(
        apiUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) },
        60000
      )
      console.timeEnd(`[Gemini] ${base}/${model}`)
      if (response.ok) {
        const data = await response.json()
        const text = extractGeminiText(data)
        if (text) {
          geminiResolvedEndpoint = { base, model }
          return text
        }
        const err = new Error('Gemini returned no text (possibly safety blocked)')
        ;(err as any).details = data
        throw err
      }
    } catch (e) {
      console.timeEnd(`[Gemini] ${base}/${model}`)
      lastErr = e
    }
  }
  // If we already resolved a working combo, try it first
  if (geminiResolvedEndpoint) {
    const { base, model } = geminiResolvedEndpoint
    const apiUrl = `https://generativelanguage.googleapis.com/${base}/models/${model}:generateContent`
    try {
      const response = await fetchWithTimeout(
        apiUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) },
        40000
      )
      if (response.ok) {
        const data = await response.json()
        const text = extractGeminiText(data)
        if (text) return text
        const err = new Error('Gemini returned no text (possibly safety blocked)')
        ;(err as any).details = data
        throw err
      }
    } catch {}
  }

  // Ensure we try 2.5-pro early in the general loop as well
  const orderedModels = ['gemini-2.5-pro', ...models.filter(m => m !== 'gemini-2.5-pro')]
  for (const base of bases) {
    for (const model of orderedModels) {
      const apiUrl = `https://generativelanguage.googleapis.com/${base}/models/${model}:generateContent`
      try {
        console.log('[Gemini] try', { base, model })
        console.time(`[Gemini] ${base}/${model}`)
        // Attempt up to 2 tries per endpoint to mitigate transient network issues
        let response: Response | null = null
        let attemptErr: any = null
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            response = await fetchWithTimeout(
              apiUrl,
              { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) },
              60000
            )
            break
          } catch (e) {
            attemptErr = e
            // brief backoff
            await delay(250)
          }
        }
        if (!response) throw attemptErr || new Error('No response')

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          const error = new Error(`API error (${model} on ${base}): ${response.status} ${response.statusText}`)
          ;(error as any).details = { ...errorData, tried: { base, model } }
          lastErr = error
          // Try next
          console.timeEnd(`[Gemini] ${base}/${model}`)
          continue
        }

        const data = await response.json()
        const text = extractGeminiText(data)
        if (text) {
          console.timeEnd(`[Gemini] ${base}/${model}`)
          geminiResolvedEndpoint = { base, model }
          return text
        }
        const err = new Error(`Gemini returned no text from ${model} on ${base} (possibly safety blocked)`)
        ;(err as any).details = data
        lastErr = err
      } catch (e) {
        console.timeEnd(`[Gemini] ${base}/${model}`)
        lastErr = e
        // Try next
      }
    }
  }

  // As a last resort, discover models dynamically via ListModels
  const discovered = await discoverFirstGenerativeModel(apiKey)
  if (discovered) {
    geminiResolvedEndpoint = discovered
    const apiUrl = `https://generativelanguage.googleapis.com/${discovered.base}/models/${discovered.model}:generateContent`
    const response = await fetchWithTimeout(
      apiUrl,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) },
      60000
    )
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const error = new Error(`API error (${discovered.model} on ${discovered.base}): ${response.status} ${response.statusText}`)
      ;(error as any).details = { ...errorData, tried: discovered }
      throw error
    }
    const data = await response.json()
    const text = extractGeminiText(data)
    if (text) return text
    const err = new Error('Empty response from discovered Gemini model (possibly safety blocked)')
    ;(err as any).details = data
    throw err
  }

  throw lastErr || new Error('Gemini request failed');
}

async function discoverFirstGenerativeModel(apiKey: string): Promise<{ base: 'v1' | 'v1beta'; model: string } | null> {
  const bases: Array<'v1' | 'v1beta'> = ['v1', 'v1beta']
  for (const base of bases) {
    try {
      const url = `https://generativelanguage.googleapis.com/${base}/models`
      const res = await fetch(url, { method: 'GET', headers: { 'x-goog-api-key': apiKey } })
      if (!res.ok) continue
      const data = await res.json()
      const models = (data?.models || []) as Array<any>
      const candidate = models.find((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      if (candidate?.name) {
        // name may be like 'models/gemini-1.5-flash'
        const parts = String(candidate.name).split('/')
        const model = parts[parts.length - 1]
        return { base, model }
      }
    } catch {}
  }
  return null
}

// --- Simple cache + fetch helper for Reddit ---
type RedditRow = { title: string; url: string; subreddit: string }
const redditCache = new Map<string, { ts: number; rows: RedditRow[] }>()
const REDDIT_TTL_MS = 2 * 60 * 1000 // 2 minutes

async function redditFetchCached(term: string): Promise<RedditRow[]> {
  const key = term.trim().toLowerCase()
  const hit = redditCache.get(key)
  const now = Date.now()
  if (hit && now - hit.ts < REDDIT_TTL_MS) {
    return hit.rows
  }
  const rows = await redditFetchWithFallback(term)
  redditCache.set(key, { ts: now, rows })
  return rows
}

async function redditFetchWithFallback(term: string): Promise<RedditRow[]> {
  // Try api -> www with a short backoff between attempts
  const urls = [
    `https://api.reddit.com/search.json?q=${encodeURIComponent(term)}&limit=5&sort=relevance`,
    `https://www.reddit.com/search.json?q=${encodeURIComponent(term)}&limit=5&sort=relevance&raw_json=1`,
  ]
  let lastErr: any = null
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i]
    try {
      const res = await fetch(u, { cache: 'no-store' })
      if (!res.ok) {
        lastErr = new Error(`status ${res.status}`)
        // brief delay before next attempt
        await delay(150)
        continue
      }
      const data = await res.json()
      const items = (data?.data?.children || []).map((p: any) => p.data)
      return items.map((it: any) => ({
        title: it.title,
        url: `https://www.reddit.com${it.permalink}`,
        subreddit: it.subreddit,
      }))
    } catch (e) {
      lastErr = e
      await delay(150)
    }
  }
  throw lastErr || new Error('Reddit fetch failed')
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
