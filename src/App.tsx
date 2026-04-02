import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { getDocument } from 'pdfjs-dist'
import PdfJsViewer, { type PdfJsViewerHandle } from './PdfJsViewer'
import { analyzePdfDocument } from './pdfAnalysis'
import type { ElementRecord } from './types'
import './App.css'

type AnalysisStatus = 'idle' | 'running' | 'ready' | 'error'

export default function App() {
  const [fileName, setFileName] = useState('未打开文件')
  const [fileData, setFileData] = useState<Uint8Array | null>(null)
  const [error, setError] = useState('')

  const [pageNumber, setPageNumber] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1)

  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>('idle')
  const [analysisProgress, setAnalysisProgress] = useState('')
  const [elementsByPage, setElementsByPage] = useState<
    Record<number, ElementRecord[]>
  >({})
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [entireWord, setEntireWord] = useState(false)
  const [searchMessage, setSearchMessage] = useState('')

  const viewerRef = useRef<PdfJsViewerHandle | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const allElements = useMemo(
    () => Object.values(elementsByPage).flat(),
    [elementsByPage],
  )
  const elementIndex = useMemo(
    () => new Map(allElements.map((item) => [item.id, item] as const)),
    [allElements],
  )
  const currentPageElements = elementsByPage[pageNumber] ?? []
  const selectedElement = selectedId ? (elementIndex.get(selectedId) ?? null) : null

  const handleOpenPdf = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const data = new Uint8Array(await file.arrayBuffer())
      setFileData(data)
      setFileName(file.name)
      setError('')
      setPageNumber(1)
      setTotalPages(0)
      setScale(1)
      setElementsByPage({})
      setSelectedId(null)
      setAnalysisStatus('idle')
      setAnalysisProgress('')
      setSearchMessage('')
    } catch {
      setError('文件读取失败，请重试。')
    } finally {
      event.target.value = ''
    }
  }

  // @ts-ignore
  const analyzeData = async (data: Uint8Array) => {
    if (analysisStatus === 'running') {
      return
    }

    setAnalysisStatus('running')
    setError('')
    setAnalysisProgress('')

    try {
      const loadingTask = getDocument({ data })
      const doc = await loadingTask.promise
      const result = await analyzePdfDocument(doc, (current, total) => {
        setAnalysisProgress(`分析中 ${current}/${total}`)
      })
      await doc.destroy()

      setElementsByPage(result.elementsByPage)
      setAnalysisStatus('ready')
      setAnalysisProgress(`分析完成，共 ${result.totalElements} 个元素`)
    } catch {
      setAnalysisStatus('error')
      setAnalysisProgress('')
      setError('分析失败，请重试或更换 PDF 文件。')
    }
  }

  useEffect(() => {
    if (!fileData) {
      return
    }
    //void analyzeData(fileData)
  }, [fileData])

  const jumpToElement = (element: ElementRecord) => {
    viewerRef.current?.goToPage(element.page)
    setSelectedId(element.id)
  }

  const runSearch = () => {
    const query = searchQuery.trim()
    if (!query) {
      setSearchMessage('请输入搜索内容。')
      viewerRef.current?.clearFind()
      return
    }

    viewerRef.current?.find(query, { caseSensitive, entireWord })
    setSearchMessage(`已执行文本搜索: ${query}`)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 'f') {
        event.preventDefault()
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
          <span>页码: {pageNumber}/{totalPages || '-'}</span>
          <span>缩放: {Math.round(scale * 100)}%</span>
          <span>{analysisProgress || '分析待完成'}</span>
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
        <aside className="panel left-panel">
          <h2>元素详情</h2>
          {selectedElement ? (
            <div className="details-grid">
              <div>
                <strong>ID</strong>
                <p>{selectedElement.id}</p>
              </div>
              <div>
                <strong>类型</strong>
                <p>{selectedElement.type}</p>
              </div>
              <div>
                <strong>页码</strong>
                <p>{selectedElement.page}</p>
              </div>
              <div>
                <strong>文本</strong>
                <p>{selectedElement.displayText || '无'}</p>
              </div>
              <div>
                <strong>标签</strong>
                <p>{selectedElement.tags.join(', ') || '无'}</p>
              </div>
              <div>
                <strong>属性</strong>
                <p>{JSON.stringify(selectedElement.rawAttrs)}</p>
              </div>
            </div>
          ) : (
            <p className="empty-tip">点击下方元素列表项后查看详情。</p>
          )}

          <h2>当前页元素</h2>
          <ul className="search-results">
            {currentPageElements.slice(0, 80).map((element) => (
              <li key={element.id}>
                <button type="button" onClick={() => jumpToElement(element)}>
                  <span className="result-title">P{element.page} · {element.type}</span>
                  <span className="result-summary">{element.displayText || element.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <button type="button" onClick={() => viewerRef.current?.prevPage()} disabled={!fileData}>
              上一页
            </button>
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
          </div>

          <div className="viewer-surface">
            <PdfJsViewer
              ref={viewerRef}
              fileData={fileData}
              onError={setError}
              onPageChange={(page, total) => {
                setPageNumber(page)
                setTotalPages(total)
              }}
              onScaleChange={(value) => setScale(value)}
            />
          </div>

          {!fileData ? <p className="empty-tip">请选择 PDF 文件后开始。</p> : null}
        </section>

        <aside className="panel right-panel">
          <h2>文本搜索</h2>
          <label htmlFor="search-input" className="search-label">
            使用官方文本层搜索（Cmd/Ctrl+F 聚焦）
          </label>
          <input
            id="search-input"
            type="search"
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runSearch()
              }
            }}
            placeholder="输入关键字并回车"
          />

          <label className="regex-toggle" htmlFor="case-sensitive">
            <input
              id="case-sensitive"
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            区分大小写
          </label>

          <label className="regex-toggle" htmlFor="entire-word">
            <input
              id="entire-word"
              type="checkbox"
              checked={entireWord}
              onChange={(event) => setEntireWord(event.target.checked)}
            />
            整词匹配
          </label>

          <div className="search-actions">
            <button type="button" onClick={() => viewerRef.current?.findPrevious()}>
              上一个
            </button>
            <button type="button" onClick={() => viewerRef.current?.findNext()}>
              下一个
            </button>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
                setSearchMessage('')
                viewerRef.current?.clearFind()
              }}
            >
              清空
            </button>
          </div>

          <p className="search-message">{searchMessage || '在输入框按回车触发搜索。'}</p>
        </aside>
      </main>

    </div>
  )
}
