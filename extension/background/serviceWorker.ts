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

async function handleGeminiRequest(prompt: string, context: string = ''): Promise<string> {
  // Get the API key from storage
  const result = await chrome.storage.sync.get('GEMINI_API_KEY');
  const apiKey = result.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error('Gemini API key not found. Please set it in the extension options.');
  }

  // Prepare request body
  const body = {
    contents: [{
      role: 'user',
      parts: [{
        text: `${prompt}\n\nContext:\n${context || 'No additional context provided.'}`
      }],
    }],
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 1024,
    },
  };

  // Try preferred model first, then fallback
  const models = [
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ];

  let lastErr: any = null;
  for (const model of models) {
    const apiUrl = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(`API error (${model}): ${response.status} ${response.statusText}`);
        (error as any).details = errorData;
        lastErr = error;
        // Try next model
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
      lastErr = new Error(`Empty response from ${model}`);
    } catch (e) {
      lastErr = e;
      // Try next model
    }
  }

  throw lastErr || new Error('Gemini request failed');
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
