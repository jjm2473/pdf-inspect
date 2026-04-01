import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { analyzePdfDocument } from './pdfAnalysis'
import type { ElementRecord } from './types'
import './App.css'

type AnalysisStatus = 'idle' | 'running' | 'ready' | 'error'

type SearchResult = {
  elementId: string
  page: number
  type: ElementRecord['type']
  summary: string
  tags: string[]
}

const DEFAULT_SCALE = 1.35

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

function parseKeywordGroups(rawInput: string): string[][] {
  return rawInput
    .split('|')
    .map((group) => group.trim())
    .filter((group) => group.length > 0)
    .map((group) => group.split(/\s+/).filter((token) => token.length > 0))
}

function matchByKeywords(haystack: string, groups: string[][]): boolean {
  if (groups.length === 0) {
    return false
  }

  return groups.some((group) =>
    group.every((token) => haystack.includes(token.toLowerCase())),
  )
}

function pointInBox(x: number, y: number, element: ElementRecord): boolean {
  const { bbox } = element
  return (
    x >= bbox.x &&
    x <= bbox.x + bbox.width &&
    y >= bbox.y &&
    y <= bbox.y + bbox.height
  )
}

function toOverlayStyle(
  element: ElementRecord,
  scale: number,
  extra: CSSProperties = {},
): CSSProperties {
  return {
    left: `${element.bbox.x * scale}px`,
    top: `${element.bbox.y * scale}px`,
    width: `${Math.max(1, element.bbox.width * scale)}px`,
    height: `${Math.max(1, element.bbox.height * scale)}px`,
    ...extra,
  }
}

function formatTags(tags: string[]): string {
  if (tags.length === 0) {
    return '无'
  }

  return tags.join(', ')
}

function App() {
  const [fileName, setFileName] = useState('未打开文件')
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [renderSize, setRenderSize] = useState({ width: 0, height: 0 })

  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>('idle')
  const [analysisError, setAnalysisError] = useState('')
  const [analysisProgress, setAnalysisProgress] = useState('')
  const [elementsByPage, setElementsByPage] = useState<
    Record<number, ElementRecord[]>
  >({})

  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [regexMode, setRegexMode] = useState(false)
  const [searchMessage, setSearchMessage] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null)

  const allElements = useMemo(
    () => Object.values(elementsByPage).flat(),
    [elementsByPage],
  )

  const elementIndex = useMemo(() => {
    return new Map(allElements.map((element) => [element.id, element] as const))
  }, [allElements])

  const currentPageElements = elementsByPage[pageNumber] ?? []
  const selectedElement = selectedId ? (elementIndex.get(selectedId) ?? null) : null
  const hoveredElement = hoveredId ? (elementIndex.get(hoveredId) ?? null) : null
  const inspectedElement = selectedElement ?? hoveredElement

  const totalPages = pdfDoc?.numPages ?? 0
  const canAnalyze = Boolean(pdfDoc) && analysisStatus !== 'running'
  const hasAnalysisData = allElements.length > 0

  useEffect(() => {
    const handleHotkey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const isFindShortcut = (event.metaKey || event.ctrlKey) && key === 'f'

      if (isFindShortcut) {
        event.preventDefault()
        setSearchOpen(true)
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        })
      }

      if (key === 'escape' && searchOpen) {
        setSearchOpen(false)
      }
    }

    window.addEventListener('keydown', handleHotkey)
    return () => {
      window.removeEventListener('keydown', handleHotkey)
    }
  }, [searchOpen])

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) {
      return
    }

    const canvas = canvasRef.current
    let cancelled = false

    const renderPage = async () => {
      const page = await pdfDoc.getPage(pageNumber)
      if (cancelled) {
        return
      }

      const viewport = page.getViewport({ scale })
      const pixelRatio = window.devicePixelRatio || 1
      const context = canvas.getContext('2d')

      if (!context) {
        return
      }

      canvas.width = Math.floor(viewport.width * pixelRatio)
      canvas.height = Math.floor(viewport.height * pixelRatio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

      renderTaskRef.current?.cancel()
      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
      })
      renderTaskRef.current = renderTask

      await renderTask.promise

      if (!cancelled) {
        setRenderSize({ width: viewport.width, height: viewport.height })
      }
    }

    renderPage().catch((error: unknown) => {
      if (error instanceof Error && error.name === 'RenderingCancelledException') {
        return
      }
      setAnalysisError('页面渲染失败，请尝试重新打开 PDF 文件。')
    })

    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
    }
  }, [pdfDoc, pageNumber, scale])

  const clearAnalysis = () => {
    setElementsByPage({})
    setHoveredId(null)
    setSelectedId(null)
    setSearchResults([])
    setSearchMessage('')
    setAnalysisStatus('idle')
    setAnalysisError('')
    setAnalysisProgress('')
  }

  const handleOpenPdf = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const targetFile = event.target.files?.[0]
    if (!targetFile) {
      return
    }

    try {
      const fileBuffer = await targetFile.arrayBuffer()
      const loadingTask = getDocument({ data: new Uint8Array(fileBuffer) })
      const loadedPdf = await loadingTask.promise

      setPdfDoc(loadedPdf)
      setFileName(targetFile.name)
      setPageNumber(1)
      setScale(DEFAULT_SCALE)
      clearAnalysis()
    } catch {
      setAnalysisStatus('error')
      setAnalysisError('PDF 打开失败，请确认文件未损坏或未加密。')
    } finally {
      event.target.value = ''
    }
  }

  const handleAnalyze = async (): Promise<void> => {
    if (!pdfDoc) {
      return
    }

    setAnalysisStatus('running')
    setAnalysisError('')
    setSearchMessage('')

    try {
      const result = await analyzePdfDocument(pdfDoc, (current, total) => {
        setAnalysisProgress(`分析中 ${current}/${total}`)
      })

      setElementsByPage(result.elementsByPage)
      setAnalysisStatus('ready')
      setAnalysisProgress(`分析完成，共 ${result.totalElements} 个元素`) 

      if (
        selectedId &&
        !Object.values(result.elementsByPage)
          .flat()
          .some((element) => element.id === selectedId)
      ) {
        setSelectedId(null)
      }
    } catch {
      setAnalysisStatus('error')
      setAnalysisError('分析失败，请重试或更换 PDF 文件。')
      setAnalysisProgress('')
    }
  }

  const pickTopElement = (x: number, y: number): ElementRecord | null => {
    const hitElements = currentPageElements.filter((element) =>
      pointInBox(x, y, element),
    )

    if (hitElements.length === 0) {
      return null
    }

    hitElements.sort((left, right) => {
      const leftArea = left.bbox.width * left.bbox.height
      const rightArea = right.bbox.width * right.bbox.height
      return leftArea - rightArea
    })

    return hitElements[0]
  }

  const handleOverlayMouseMove = (
    event: React.MouseEvent<HTMLDivElement>,
  ): void => {
    if (!hasAnalysisData) {
      return
    }

    const overlayRect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - overlayRect.left) / scale
    const y = (event.clientY - overlayRect.top) / scale
    const hitElement = pickTopElement(x, y)
    const nextHoveredId = hitElement?.id ?? null

    setHoveredId((previous) => (previous === nextHoveredId ? previous : nextHoveredId))
  }

  const handleOverlayClick = (
    event: React.MouseEvent<HTMLDivElement>,
  ): void => {
    if (!hasAnalysisData) {
      return
    }

    const overlayRect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - overlayRect.left) / scale
    const y = (event.clientY - overlayRect.top) / scale
    const hitElement = pickTopElement(x, y)

    if (hitElement) {
      setSelectedId(hitElement.id)
    }
  }

  const runSearch = (): void => {
    if (!hasAnalysisData) {
      setSearchMessage('请先点击“分析”。')
      return
    }

    const query = searchQuery.trim()
    if (!query) {
      setSearchResults([])
      setSearchMessage('请输入搜索内容。')
      return
    }

    const source = allElements.map((element) => {
      return {
        element,
        haystack: `${element.displayText} ${element.tags.join(' ')}`,
      }
    })

    try {
      let matchedElements: ElementRecord[] = []

      if (regexMode) {
        const regExp = new RegExp(query, 'i')
        matchedElements = source
          .filter((item) => regExp.test(item.haystack))
          .map((item) => item.element)
      } else {
        const groups = parseKeywordGroups(query)
        matchedElements = source
          .filter((item) => matchByKeywords(item.haystack.toLowerCase(), groups))
          .map((item) => item.element)
      }

      const nextResults = matchedElements
        .sort((left, right) => left.page - right.page)
        .map((element) => ({
          elementId: element.id,
          page: element.page,
          type: element.type,
          summary: element.displayText || `${element.type.toUpperCase()} 元素`,
          tags: element.tags,
        }))

      setSearchResults(nextResults)
      setSearchMessage(`命中 ${nextResults.length} 项`) 
    } catch {
      setSearchResults([])
      setSearchMessage('正则表达式无效，请检查后重试。')
    }
  }

  const selectBySearchResult = (result: SearchResult): void => {
    setPageNumber(result.page)
    setSelectedId(result.elementId)
    setHoveredId(null)
  }

  const inspectMarkers = [
    selectedElement && selectedElement.page === pageNumber
      ? { kind: 'selected' as const, element: selectedElement }
      : null,
    hoveredElement && hoveredElement.page === pageNumber
      ? { kind: 'hovered' as const, element: hoveredElement }
      : null,
  ].filter((item): item is { kind: 'selected' | 'hovered'; element: ElementRecord } => Boolean(item))

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="app-title">
          <h1>PDF Inspect</h1>
          <p>可视化检查文本与线条属性，支持交互高亮与搜索定位。</p>
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

          <button
            className="analyze-button"
            type="button"
            onClick={handleAnalyze}
            disabled={!canAnalyze}
          >
            {analysisStatus === 'running' ? '分析中...' : '分析'}
          </button>

          <button
            className="search-toggle"
            type="button"
            onClick={() => setSearchOpen((open) => !open)}
          >
            搜索 (Cmd/Ctrl+F)
          </button>
        </div>
      </header>

      <div className="status-row">
        <span className="file-pill">文件: {fileName}</span>
        <span>页码: {pageNumber}/{totalPages || '-'}</span>
        <span>{analysisProgress || '等待分析'}</span>
        {analysisError ? <span className="status-error">{analysisError}</span> : null}
      </div>

      <main className="layout">
        <aside className="panel left-panel">
          <h2>元素详情</h2>
          {inspectedElement ? (
            <div className="details-grid">
              <div>
                <strong>ID</strong>
                <p>{inspectedElement.id}</p>
              </div>
              <div>
                <strong>类型</strong>
                <p>{inspectedElement.type}</p>
              </div>
              <div>
                <strong>页码</strong>
                <p>{inspectedElement.page}</p>
              </div>
              <div>
                <strong>显示文本</strong>
                <p>{inspectedElement.displayText || '无'}</p>
              </div>
              <div>
                <strong>标签</strong>
                <p>{formatTags(inspectedElement.tags)}</p>
              </div>
              <div>
                <strong>关系</strong>
                <p>{formatTags(inspectedElement.relations)}</p>
              </div>
              <div>
                <strong>边框</strong>
                <p>
                  x={inspectedElement.bbox.x.toFixed(1)}, y={inspectedElement.bbox.y.toFixed(1)},
                  w={inspectedElement.bbox.width.toFixed(1)}, h={inspectedElement.bbox.height.toFixed(1)}
                </p>
              </div>
              <div>
                <strong>原始属性</strong>
                <p>{JSON.stringify(inspectedElement.rawAttrs)}</p>
              </div>
            </div>
          ) : (
            <p className="empty-tip">悬浮或点击元素后，在这里查看详细属性。</p>
          )}
        </aside>

        <section className="viewer-panel">
          <div className="viewer-toolbar">
            <button
              type="button"
              onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
              disabled={!pdfDoc || pageNumber <= 1}
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() =>
                setPageNumber((value) => Math.min(totalPages || 1, value + 1))
              }
              disabled={!pdfDoc || pageNumber >= (totalPages || 1)}
            >
              下一页
            </button>

            <label htmlFor="scale-range">
              缩放
              <input
                id="scale-range"
                type="range"
                min={0.7}
                max={2.2}
                step={0.05}
                value={scale}
                onChange={(event) => setScale(Number(event.target.value))}
              />
            </label>

            <span>{Math.round(scale * 100)}%</span>
          </div>

          <div className="canvas-stage" style={{ width: `${renderSize.width}px` }}>
            <canvas ref={canvasRef} className="pdf-canvas" />
            <div
              className="overlay"
              style={{ width: `${renderSize.width}px`, height: `${renderSize.height}px` }}
              onMouseMove={handleOverlayMouseMove}
              onMouseLeave={() => setHoveredId(null)}
              onClick={handleOverlayClick}
            >
              {inspectMarkers.map((marker) => (
                <div
                  key={`${marker.kind}-${marker.element.id}`}
                  className={`hitbox ${marker.kind}`}
                  style={toOverlayStyle(marker.element, scale)}
                />
              ))}
            </div>
          </div>

          {!pdfDoc ? <p className="empty-tip">请选择 PDF 文件后开始。</p> : null}
        </section>

        {searchOpen ? (
          <aside className="panel right-panel">
            <h2>搜索</h2>
            <label htmlFor="search-input" className="search-label">
              关键字 / 多关键字 / 正则
            </label>
            <input
              id="search-input"
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  runSearch()
                }
              }}
              placeholder="例如: invoice total | subtotal"
            />

            <label className="regex-toggle" htmlFor="regex-mode">
              <input
                id="regex-mode"
                type="checkbox"
                checked={regexMode}
                onChange={(event) => setRegexMode(event.target.checked)}
              />
              使用正则模式
            </label>

            <div className="search-actions">
              <button type="button" onClick={runSearch}>
                搜索
              </button>
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('')
                  setSearchResults([])
                  setSearchMessage('')
                }}
              >
                清空
              </button>
            </div>

            <p className="search-message">{searchMessage || '输入后按回车执行搜索'}</p>

            <ul className="search-results">
              {searchResults.map((result) => (
                <li key={result.elementId}>
                  <button type="button" onClick={() => selectBySearchResult(result)}>
                    <span className="result-title">P{result.page} · {result.type}</span>
                    <span className="result-summary">{result.summary}</span>
                    <span className="result-tags">{formatTags(result.tags)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
      </main>

      <footer className="app-footer">
        <small>流程: 打开文件 → 翻页 → 分析 → 悬浮高亮 → 点击查看详情 → 搜索定位</small>
      </footer>
    </div>
  )
}

export default App
