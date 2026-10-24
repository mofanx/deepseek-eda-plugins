import net from 'node:net'

const PORTS = []
for (let p = 49620; p <= 49630; p++) PORTS.push(p)

function tcp(port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    let done = false
    const finish = (r) => { if (done) return; done = true; try { s.destroy() } catch {}; resolve(r) }
    s.setTimeout(timeout)
    s.once('connect', () => finish({ ok: true }))
    s.once('timeout', () => finish({ ok: false, err: 'TIMEOUT' }))
    s.once('error', (e) => finish({ ok: false, err: e.code || e.message }))
    s.connect(port, '127.0.0.1')
  })
}

console.log('=== LAYER (a) raw TCP connect ===')
for (const p of PORTS) {
  const r = await tcp(p)
  console.log(`  127.0.0.1:${p}  connected=${r.ok}${r.ok ? '' : '  err=' + r.err}`)
}

console.log('\n=== LAYER (b) GET /health ===')
for (const p of PORTS) {
  const url = `http://127.0.0.1:${p}/health`
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 3000)
  try {
    const res = await fetch(url, { signal: ac.signal })
    const body = await res.text()
    console.log(`  ${url}`)
    console.log(`    status=${res.status} ${res.statusText}  content-type=${res.headers.get('content-type')}`)
    console.log(`    body(first200)=${JSON.stringify(body.slice(0, 200))}`)
  } catch (e) {
    console.log(`  ${url}`)
    console.log(`    FETCH_FAILED  name=${e.name}  message=${(e.message || '').slice(0, 160)}`)
  } finally {
    clearTimeout(t)
  }
}
