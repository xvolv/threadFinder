/// <reference types="chrome-types"/>
// Content script: injects an in-page panel to show discussion results without opening a new tab
// Listens for messages from background with the selected term

// Simple DOM helpers
function createPanel() {
  const host = document.createElement('div')
  host.id = 'threadfinder-panel-host'
  host.style.position = 'fixed'
  host.style.bottom = '16px'
  host.style.right = '16px'
  host.style.zIndex = '2147483647'
  host.style.width = '440px'
  host.style.maxHeight = '60vh'
  host.style.boxShadow = '0 10px 30px rgba(0,0,0,0.2)'
  host.style.borderRadius = '10px'
  host.style.overflow = 'hidden'

  const shadow = host.attachShadow({ mode: 'open' })
  const container = document.createElement('div')
  container.style.fontFamily = 'system-ui, Arial, sans-serif'
  container.style.background = 'white'
  container.style.border = '1px solid #e5e7eb'

  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:#111827; color:white;">
      <div style="display:flex; align-items:center; gap:8px; font-weight:600;">🧵 ThreadFinder</div>
      <button id="tf-close" style="background:transparent; border:none; color:#e5e7eb; font-size:16px; cursor:pointer">✕</button>
    </div>
    <div style="padding:10px 12px; border-bottom: 1px solid #e5e7eb;">
      <div id="tf-term" style="font-size:12px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div>
      <div style="margin-top:8px; display:flex; gap:8px; flex-wrap: wrap;">
        <button data-site="reddit" class="tf-tab" style="display:flex; align-items:center; gap:6px; padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb; border-radius:6px; cursor:pointer">Reddit</button>
        <button data-site="stackoverflow" class="tf-tab" style="display:flex; align-items:center; gap:6px; padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb; border-radius:6px; cursor:pointer">StackOverflow</button>
        <button data-site="wikipedia" class="tf-tab" style="display:flex; align-items:center; gap:6px; padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb; border-radius:6px; cursor:pointer">Wikipedia</button>
        <button data-site="gemini-answer" class="tf-tab" style="display:flex; align-items:center; gap:6px; padding:6px 10px; border:1px solid #e5e7eb; background:#f9fafb; border-radius:6px; cursor:pointer">Gemini Answer</button>
      </div>
    </div>
    <div id="tf-results" style="padding:10px 12px; overflow:auto; max-height: 45vh;">
      <div style="color:#6b7280;">Pick a source above to see results here.</div>
    </div>
  `

  shadow.appendChild(container)

  // Inject SVG icons for buttons using extension URLs
  try {
    const r = shadow.querySelector('button.tf-tab[data-site="reddit"]') as HTMLButtonElement | null
    const s = shadow.querySelector('button.tf-tab[data-site="stackoverflow"]') as HTMLButtonElement | null
    const w = shadow.querySelector('button.tf-tab[data-site="wikipedia"]') as HTMLButtonElement | null
    const ga = shadow.querySelector('button.tf-tab[data-site="gemini-answer"]') as HTMLButtonElement | null
    const rIcon = (chrome.runtime as any)?.getURL ? (chrome.runtime as any).getURL('reddit.svg') : 'reddit.svg'
    const sIcon = (chrome.runtime as any)?.getURL ? (chrome.runtime as any).getURL('stackoverflow.svg') : 'stackoverflow.svg'
    const wIcon = (chrome.runtime as any)?.getURL ? (chrome.runtime as any).getURL('wikipedia.svg') : 'wikipedia.svg'
    const gIcon = (chrome.runtime as any)?.getURL ? (chrome.runtime as any).getURL('gemini.svg') : 'gemini.svg'
    if (r) r.innerHTML = `<img alt="Reddit" src="${rIcon}" style="width:16px;height:16px;display:inline-block;"/> <span>Reddit</span>`
    if (s) s.innerHTML = `<img alt="StackOverflow" src="${sIcon}" style="width:16px;height:16px;display:inline-block;"/> <span>StackOverflow</span>`
    if (w) w.innerHTML = `<img alt="Wikipedia" src="${wIcon}" style="width:16px;height:16px;display:inline-block;"/> <span>Wikipedia</span>`
    if (ga) ga.innerHTML = `<img alt="Gemini Answer" src="${gIcon}" style="width:16px;height:16px;display:inline-block;"/> <span>Gemini Answer</span>`
  } catch {}
  return { host, shadow, container }
}

function setResults(container: ShadowRoot, html: string) {
  const results = container.getElementById('tf-results') as HTMLElement
  if (results) results.innerHTML = html
}

async function fetchReddit(term: string) {
  return await new Promise<any[]>((resolve, reject) => {
    try {
      ;(chrome.runtime.sendMessage as any)({ type: 'threadfinder:fetchReddit', term }, (res: any) => {
        if ((chrome.runtime as any).lastError) {
          reject(new Error((chrome.runtime as any).lastError.message))
          return
        }
        if (!res || !res.ok) {
          reject(new Error(res?.error || 'Reddit request failed'))
          return
        }
        resolve(res.items as any[])
      })
    } catch (e) {
      reject(e)
    }
  })
}

async function fetchStackOverflow(term: string) {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(term)}&site=stackoverflow&pagesize=5`
  const res = await fetch(url)
  if (!res.ok) throw new Error('StackOverflow request failed')
  const data = await res.json()
  const items = data?.items || []
  return items.map((it: any) => ({
    title: it.title,
    url: it.link,
    score: it.score,
    answers: it.answer_count,
  }))
}

async function fetchWikipedia(term: string) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&origin=*&srlimit=5`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Wikipedia request failed')
  const data = await res.json()
  const items = data?.query?.search || []
  return items.map((it: any) => {
    const title = it.title as string
    const slug = title.replace(/ /g, '_')
    const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`
    const snippet = String(it.snippet || '').replace(/<[^>]+>/g, '')
    return { title, url: pageUrl, extra: snippet }
  })
}

async function fetchGemini(prompt: string, context: string = '') {
  function send(): Promise<any> {
    return new Promise((resolve, reject) => {
      try {
        (chrome.runtime.sendMessage as any)(
          { type: 'threadfinder:gemini', prompt, context },
          (res: any) => {
            const le = (chrome.runtime as any).lastError
            if (le) {
              reject(new Error(le.message))
              return
            }
            resolve(res)
          }
        )
      } catch (e) {
        reject(e)
      }
    })
  }

  // Add a timeout; allow longer window to accommodate model latency
  const withTimeout = <T>(p: Promise<T>, ms = 45000) =>
    new Promise<T>((resolve, reject) => {
      const id = setTimeout(() => reject(new Error('Gemini request timed out')), ms)
      p.then((v) => {
        clearTimeout(id)
        resolve(v)
      }).catch((e) => {
        clearTimeout(id)
        reject(e)
      })
    })

  try {
    return await withTimeout(send())
  } catch (e: any) {
    // Retry once if receiving end missing (SW cold start)
    if (String(e?.message || e).includes('Receiving end does not exist')) {
      await new Promise((r) => setTimeout(r, 300))
      return await withTimeout(send())
    }
    // If the extension was reloaded, the page needs a refresh to re-inject content scripts
    const msg = String(e?.message || e)
    if (msg.includes('Extension context invalidated') || msg.includes('The message port closed')) {
      return { error: 'The extension was reloaded. Please refresh this page and try again.' }
    }
    throw e
  }
}

function renderList(items: Array<{ title: string; url: string; extra?: string }>) {
  if (!items.length) return '<div style="color:#6b7280;">No results found.</div>'
  return `
    <ul style="list-style:none; padding:0; margin:0; display:grid; gap:8px;">
      ${items
        .map(
          (it) => `
        <li class="tf-result" style="border:1px solid #e5e7eb; border-radius:8px; padding:8px 10px;">
          <a href="${it.url}" target="_blank" style="text-decoration:none; color:#111827; font-weight:600;">${it.title}</a>
          ${it.extra ? `<div style=\"font-size:12px; color:#6b7280; margin-top:2px;\">${it.extra}</div>` : ''}
        </li>`
        )
        .join('')}
    </ul>
  `
}

function showPanel(term: string) {
  // Remove existing panel
  document.getElementById('threadfinder-panel-host')?.remove()

  const { host, shadow, container } = createPanel()
  document.documentElement.appendChild(host)

  const termEl = shadow.getElementById('tf-term')
  if (termEl) termEl.textContent = `Selection: ${term}`

  const closeBtn = shadow.getElementById('tf-close')
  closeBtn?.addEventListener('click', () => {
    tfLastShown = ''
    host.remove()
  })

  function setLoading(site: string) {
    setResults(shadow, `<div style="color:#6b7280;">Loading ${site}…</div>`)
  }

  async function handleTab(site: string) {
    try {
      setLoading(site)
      if (site === 'reddit') {
        const rows = await fetchReddit(term)
        const list = renderList(
          rows.map((r) => ({ title: r.title, url: r.url, extra: `r/${r.subreddit}` }))
        )
        setResults(shadow, list)
      } else if (site === 'stackoverflow') {
        const rows = await fetchStackOverflow(term)
        const list = renderList(
          rows.map((r) => ({ title: r.title, url: r.url, extra: `${r.answers} answers · score ${r.score}` }))
        )
        setResults(shadow, list)
      } else if (site === 'wikipedia') {
        const rows = await fetchWikipedia(term)
        const list = renderList(
          rows.map((r) => ({ title: r.title, url: r.url, extra: r.extra }))
        )
        setResults(shadow, list)
      } else if (site === 'gemini-answer') {
        setResults(shadow, '<div style="color:#6b7280; padding: 12px;">Asking Gemini about your selection...</div>')
        const termShort = term.length > 1200 ? term.slice(0, 1200) + '...' : term
        const question = `Answer the following question or provide information about the following text: ${termShort}`
        const ctx = `The user selected this text on a webpage (truncated): ${termShort}`
        const response = await fetchGemini(question, ctx)
        
        if (response.error) {
          const details = response.details ? `<pre style="white-space:pre-wrap; font-size:12px; color:#6b7280; margin-top:6px;">${JSON.stringify(response.details, null, 2)}</pre>` : ''
          setResults(shadow, `<div style="color:#b91c1c; padding: 12px;">Error: ${response.error}${details}</div>`)
        } else {
          const text = response.text || 'No response from Gemini'
          setResults(shadow, `
            <div style="padding: 12px;">
              <h3 style="font-weight: 600; margin-bottom: 8px; color: #111827;">Gemini's Response:</h3>
              <div style="white-space: pre-wrap; line-height: 1.5; color: #1f2937;">${text}</div>
            </div>
          `)
        }
      }
    } catch (e) {
      if (site === 'reddit') {
        const rurl = `https://www.reddit.com/search?q=${encodeURIComponent(term)}`
        setResults(
          shadow,
          `<div>Couldn’t load Reddit inline. <a href="${rurl}" target="_blank">Open results on Reddit</a>.</div>`
        )
      } else if (site === 'gemini-answer') {
        setResults(shadow, `<div style="color:#b91c1c; padding: 12px;">Error with Gemini: ${e.message || 'Unknown error'}</div>`)
      } else {
        setResults(shadow, `<div style="color:#b91c1c; padding: 12px;">Error loading ${site}.</div>`)
      }
    }
  }

  shadow.querySelectorAll('.tf-tab').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const site = (e.currentTarget as HTMLElement).getAttribute('data-site')!
      handleTab(site)
    })
  })
}

// Show panel when user selects text on the page
function getSelectedText() {
  const sel = window.getSelection()
  return sel ? sel.toString().trim() : ''
}

let tfLastShown = ''
function maybeShowFromSelection() {
  const term = getSelectedText()
  if (term && term !== tfLastShown) {
    tfLastShown = term
    showPanel(term)
  }
}

document.addEventListener('mouseup', () => {
  // Delay slightly to allow selection to finalize
  setTimeout(maybeShowFromSelection, 0)
})

document.addEventListener('keyup', (e) => {
  if (e.key === 'Shift' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    setTimeout(maybeShowFromSelection, 0)
  }
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'threadfinder:search' && typeof msg.term === 'string') {
    showPanel(msg.term)
    sendResponse()
    return false
  }
  return false
})
