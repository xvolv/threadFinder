import React from 'react'
import { createRoot } from 'react-dom/client'

const App = () => {
  const [q, setQ] = React.useState('')

  const runSearch = () => {
    const term = q.trim()
    if (!term) return
    const siteQuery = ['reddit.com', 'stackoverflow.com', 'wikipedia.org']
      .map(s => `site:${s}`)
      .join(' OR ')
    const url = `https://www.google.com/search?q=${encodeURIComponent(`${term} ${siteQuery}`)}`
    // Open in a new tab; using window.open is sufficient from popup UI
    window.open(url, '_blank')
  }

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === 'Enter') runSearch()
  }

  return (
    <div style={{ padding: '1rem', width: 320, fontFamily: 'system-ui, Arial, sans-serif' }}>
      <h3 style={{ marginTop: 0, marginBottom: 8 }}>ThreadFinder</h3>
      <p style={{ marginTop: 0, color: '#444' }}>Search discussions from Reddit, StackOverflow, and Wikipedia.</p>
      <input
        autoFocus
        value={q}
        onChange={e => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Enter your topic..."
        style={{
          width: '100%',
          padding: '8px 10px',
          border: '1px solid #ccc',
          borderRadius: 6,
          marginBottom: 8,
          boxSizing: 'border-box',
        }}
      />
      <button
        onClick={runSearch}
        style={{
          width: '100%',
          padding: '8px 10px',
          background: '#2563eb',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
        }}
      >
        Search
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
