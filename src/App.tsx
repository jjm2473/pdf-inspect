import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import PdfJsViewer, {
  type PdfJsViewerHandle,
  type PdfSearchResult,
} from './PdfJsViewer'
import './App.css'

export default function App() {
  const [fileName, setFileName] = useState('未打开文件')
  const [fileData, setFileData] = useState<Uint8Array | null>(null)
  const [error, setError] = useState('')
  const [isFileReading, setIsFileReading] = useState(false)
  const [isPdfLoading, setIsPdfLoading] = useState(false)
  const [pdfLoadProgress, setPdfLoadProgress] = useState<{ loaded: number; total: number | null }>({
    loaded: 0,
    total: null,
  })

  const [pageNumber, setPageNumber] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1)
  const [pageInput, setPageInput] = useState('1')

  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [searchMessage, setSearchMessage] = useState('')
  const [searchResults, setSearchResults] = useState<PdfSearchResult[]>([])
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null)
  const [activeQuery, setActiveQuery] = useState('')
  const [activeCaseSensitive, setActiveCaseSensitive] = useState(false)

  const viewerRef = useRef<PdfJsViewerHandle | null>(null)
  const viewerSurfaceRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const currentPageResultCount = useMemo(
    () => searchResults.filter((item) => item.page === pageNumber).length,
    [searchResults, pageNumber],
  )
  const groupedSearchResults = useMemo(() => {
    const groups = new Map<number, PdfSearchResult[]>()
    for (const result of searchResults) {
      const list = groups.get(result.page)
      if (list) {
        list.push(result)
      } else {
        groups.set(result.page, [result])
      }
    }
    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([page, results]) => ({ page, results }))
  }, [searchResults])

  const loadingLabel = useMemo(() => {
    if (isFileReading) {
      return '正在读取文件...'
    }
    if (!isPdfLoading) {
      return ''
    }
    const { loaded, total } = pdfLoadProgress
    if (total && total > 0) {
      const percent = Math.min(100, Math.round((loaded / total) * 100))
      return `正在解析 PDF ${percent}%`
    }
    return '正在解析 PDF...'
  }, [isFileReading, isPdfLoading, pdfLoadProgress])
  const isLoading = isFileReading || isPdfLoading

  useEffect(() => {
    setPageInput(String(pageNumber))
  }, [pageNumber])

  const commitPageInput = () => {
    if (!fileData || totalPages <= 0) {
      setPageInput(String(pageNumber))
      return
    }

    const trimmed = pageInput.trim()
    if (!trimmed) {
      setPageInput(String(pageNumber))
      return
    }

    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      setPageInput(String(pageNumber))
      return
    }

    const nextPage = Math.min(totalPages, Math.max(1, Math.round(parsed)))
    setPageInput(String(nextPage))
    viewerRef.current?.goToPage(nextPage)
  }

  const handleOpenPdf = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      setIsFileReading(true)
      setIsPdfLoading(true)
      setPdfLoadProgress({ loaded: 0, total: null })
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve())
      })

      const data = new Uint8Array(await file.arrayBuffer())
      setFileData(data)
      setFileName(file.name)
      setError('')
      setPageNumber(1)
      setTotalPages(0)
      setScale(1)
      setSearchResults([])
      setSelectedResultId(null)
      setSearchMessage('')
      setActiveQuery('')
    } catch {
      setError('文件读取失败，请重试。')
      setIsPdfLoading(false)
    } finally {
      setIsFileReading(false)
      event.target.value = ''
    }
  }

  const runSearch = async () => {
    const query = searchQuery.trim()
    if (!query) {
      setSearchMessage('请输入搜索内容。')
      viewerRef.current?.clearFind()
      setSearchResults([])
      setSelectedResultId(null)
      return
    }

    const results = await viewerRef.current?.searchAll(query, {
      caseSensitive,
    })
    const nextResults = results ?? []
    setSearchResults(nextResults)
    setSelectedResultId(null)
    setActiveQuery(query)
    setActiveCaseSensitive(caseSensitive)
    setSearchMessage(`命中 ${nextResults.length} 项`)
  }

  const renderHighlightedSnippet = (snippet: string) => {
    if (!snippet) {
      return '(空文本片段)'
    }

    const cropSnippet = (text: string, query: string, maxLength: number) => {
      if (text.length <= maxLength) {
        return text
      }

      if (!query) {
        return `${text.slice(0, maxLength - 1)}…`
      }

      const source = activeCaseSensitive ? text : text.toLocaleLowerCase()
      const target = activeCaseSensitive ? query : query.toLocaleLowerCase()
      const hitStart = source.indexOf(target)

      if (hitStart < 0) {
        return `${text.slice(0, maxLength - 1)}…`
      }

      const hitLength = query.length
      let from = Math.max(0, hitStart - Math.floor((maxLength - hitLength) / 2))
      let to = Math.min(text.length, from + maxLength)
      from = Math.max(0, to - maxLength)

      let clipped = text.slice(from, to)
      if (from > 0) {
        clipped = `…${clipped.slice(1)}`
      }
      if (to < text.length) {
        clipped = `${clipped.slice(0, -1)}…`
      }
      return clipped
    }

	const query = activeQuery.trim()
	const queryLength = query.length
    const displaySnippet = cropSnippet(snippet, query, Math.max(37, queryLength + 2))

    if (!query) {
      return displaySnippet
    }

    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const flags = activeCaseSensitive ? 'g' : 'gi'
    const matcher = new RegExp(escapedQuery, flags)
    const parts = displaySnippet.split(matcher)
    const hits = displaySnippet.match(matcher) ?? []

    return (
      <>
        {parts.map((part, index) => (
          <span key={`p-${index}`}>
            {part}
            {hits[index] ? <mark className="snippet-hit">{hits[index]}</mark> : null}
          </span>
        ))}
      </>
    )
  }

  const focusResult = async (result: PdfSearchResult) => {
    setSelectedResultId(result.id)
    await viewerRef.current?.focusSearchResult(result)
  }

  const jumpToPageStart = (targetPage: number) => {
    setSelectedResultId(null)
    viewerRef.current?.goToPage(targetPage)
  }

  const clearSearch = () => {
    setSearchQuery('')
    setSearchMessage('')
    setSearchResults([])
    setSelectedResultId(null)
    setActiveQuery('')
    viewerRef.current?.clearFind()
    searchInputRef.current?.focus()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'f') {
        event.preventDefault()

        const selection = window.getSelection()
        const selectedText = selection?.toString().trim() ?? ''
        const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
        const commonNode = range?.commonAncestorContainer ?? null
        const surface = viewerSurfaceRef.current
        const selectedInViewer =
          !!surface &&
          !!commonNode &&
          surface.contains(commonNode.nodeType === Node.TEXT_NODE ? commonNode.parentNode : commonNode)

        if (selectedInViewer && selectedText) {
          setSearchQuery(selectedText)
        }

        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="app-title">
          <h1>PDF Inspect</h1>
        </div>

        <div className="status-row">
          <span className="file-pill">文件: {fileName}</span>
          {error ? <span className="status-error">{error}</span> : null}
        </div>

        <div className="topbar-actions">
          <label className="file-button" htmlFor="open-pdf-input">
            打开 PDF
            <input
              id="open-pdf-input"
              type="file"
              accept="application/pdf"
              onChange={handleOpenPdf}
            />
          </label>
        </div>
      </header>

      <main className="layout">
        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <button type="button" onClick={() => viewerRef.current?.prevPage()} disabled={!fileData}>
              上一页
            </button>
            <span className="page-input-group">
              <input
                id="page-number-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pageInput}
                onChange={(event) => {
                  setPageInput(event.target.value)
                }}
                onBlur={commitPageInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitPageInput()
                  }
                }}
                aria-label="页码输入"
              />
              <span>/ {totalPages || '-'}</span>
            </span>
            <button type="button" onClick={() => viewerRef.current?.nextPage()} disabled={!fileData}>
              下一页
            </button>

            <label htmlFor="scale-range">
              缩放
              <input
                id="scale-range"
                type="range"
                min={0.5}
                max={3}
                step={0.05}
                value={scale}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  setScale(value)
                  viewerRef.current?.setScale(value)
                }}
              />
            </label>

            <span>{Math.round(scale * 100)}%</span>
            
            <span>当前页命中: {currentPageResultCount}</span>
          </div>

          <div ref={viewerSurfaceRef} className="viewer-surface">
            <PdfJsViewer
              ref={viewerRef}
              fileData={fileData}
              onError={setError}
              onLoadingChange={(loading) => {
                setIsPdfLoading(loading)
                if (!loading) {
                  setPdfLoadProgress({ loaded: 0, total: null })
                }
              }}
              onLoadingProgress={(loaded, total) => {
                setPdfLoadProgress({ loaded, total })
              }}
              onPageChange={(page, total) => {
                setPageNumber(page)
                setTotalPages(total)
              }}
              onScaleChange={(value) => setScale(value)}
            />
            {isLoading ? (
              <div className="viewer-loading" role="status" aria-live="polite" aria-label={loadingLabel || '加载中'}>
                <span className="viewer-loading-spinner" aria-hidden="true" />
                <span>{loadingLabel || '加载中...'}</span>
              </div>
            ) : null}
          </div>

          {!fileData ? <p className="empty-tip">请选择 PDF 文件后开始。</p> : null}
        </section>

        <aside className="panel right-panel">
          <h2>文本搜索</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void runSearch()
            }}
          >
            <label htmlFor="search-input" className="search-label">
              搜索（Cmd/Ctrl+F 聚焦）
            </label>
            <div className="search-input-wrap">
              <input
                id="search-input"
                name="pdf_search"
                type="text"
                autoComplete="on"
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="输入关键字并回车"
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清空搜索词"
                  onClick={clearSearch}
                >
                  ×
                </button>
              ) : null}
            </div>
          </form>

          <label className="regex-toggle" htmlFor="case-sensitive">
            <input
              id="case-sensitive"
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            区分大小写
          </label>

          <ul className="search-results">
            {groupedSearchResults.map((group) => (
              <li key={`group-${group.page}`} className="search-group">
                <button
                  type="button"
                  className="search-group-title"
                  onClick={() => {
                    jumpToPageStart(group.page)
                  }}
                >
                  第 {group.page} 页 · {group.results.length} 项
                </button>

                <ul className="search-group-items">
                  {group.results.map((result) => (
                    <li key={result.id}>
                      <button
                        type="button"
                        className={selectedResultId === result.id ? 'is-active' : ''}
                        onClick={() => {
                          void focusResult(result)
                        }}
                      >
                        <span className="result-title">#{result.matchIndex + 1}</span>
                        <span className="result-summary">{renderHighlightedSnippet(result.text)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          <p className="search-message">{searchMessage || '在输入框按回车触发搜索。'}</p>
        </aside>
      </main>

    </div>
  )
}
