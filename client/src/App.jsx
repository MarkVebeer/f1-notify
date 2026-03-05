import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import './App.css'
import settingsIconPng from './img/setting.png'

axios.defaults.withCredentials = true

const DEFAULT_TRACK_LAYOUT_JSON_URL = 'https://raw.githubusercontent.com/julesr0y/f1-circuits-svg/refs/heads/main/circuits.json'
const DEFAULT_TRACK_LAYOUT_SVG_FOLDER_URL = 'https://raw.githubusercontent.com/julesr0y/f1-circuits-svg/refs/heads/main/circuits/white-outline'

const COUNTRY_ALIASES = {
  usa: 'united-states-of-america',
  'united-states': 'united-states-of-america',
  'united-states-of-america': 'united-states-of-america',
  us: 'united-states-of-america',
  uk: 'united-kingdom',
  'great-britain': 'united-kingdom',
  britain: 'united-kingdom',
  'united-arab-emirates': 'united-arab-emirates',
  uae: 'united-arab-emirates'
}

function normalizeCountryId(value) {
  if (!value) return ''

  const normalized = value
    .split(',')[0]
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return COUNTRY_ALIASES[normalized] || normalized
}

function getLatestLayoutId(layouts) {
  if (!Array.isArray(layouts) || layouts.length === 0) {
    return null
  }

  return layouts
    .map(layout => {
      const layoutId = layout?.layoutId || ''
      const lastNumber = layoutId.match(/(\d+)(?!.*\d)/)
      return {
        layoutId,
        order: lastNumber ? Number.parseInt(lastNumber[1], 10) : Number.NEGATIVE_INFINITY
      }
    })
    .filter(item => item.layoutId)
    .sort((a, b) => b.order - a.order)[0]?.layoutId || null
}

function getLayoutOrder(layoutId) {
  if (!layoutId) {
    return Number.NEGATIVE_INFINITY
  }

  const lastNumber = layoutId.match(/(\d+)(?!.*\d)/)
  return lastNumber ? Number.parseInt(lastNumber[1], 10) : Number.NEGATIVE_INFINITY
}

function getCircuitMaxSeasonYear(layouts) {
  if (!Array.isArray(layouts) || layouts.length === 0) {
    return Number.NEGATIVE_INFINITY
  }

  const years = layouts.flatMap(layout => {
    const seasonText = layout?.seasons || ''
    const matches = seasonText.match(/\d{4}/g)
    return matches ? matches.map(year => Number.parseInt(year, 10)) : []
  })

  if (years.length === 0) {
    return Number.NEGATIVE_INFINITY
  }

  return Math.max(...years)
}

function buildCountryLayoutMap(circuits) {
  const result = {}
  const bestByCountry = {}

  if (!Array.isArray(circuits)) {
    return result
  }

  circuits.forEach(circuit => {
    const countryId = normalizeCountryId(circuit?.countryId)
    const latestLayoutId = getLatestLayoutId(circuit?.layouts)
    const maxSeasonYear = getCircuitMaxSeasonYear(circuit?.layouts)
    const layoutOrder = getLayoutOrder(latestLayoutId)

    if (!countryId || !latestLayoutId) {
      return
    }

    const currentBest = bestByCountry[countryId]

    if (
      !currentBest ||
      maxSeasonYear > currentBest.maxSeasonYear ||
      (maxSeasonYear === currentBest.maxSeasonYear && layoutOrder > currentBest.layoutOrder)
    ) {
      bestByCountry[countryId] = {
        layoutId: latestLayoutId,
        maxSeasonYear,
        layoutOrder
      }
    }
  })

  Object.entries(bestByCountry).forEach(([countryId, data]) => {
    result[countryId] = data.layoutId
  })

  return result
}

function normalizeSearchText(value) {
  if (!value) {
    return ''
  }

  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getEventTimestampMs(dateInput) {
  return new Date(dateInput).getTime()
}

function getFeaturedWeekend(groupedRaces, nowDate = new Date()) {
  const threeHoursInMs = 3 * 60 * 60 * 1000
  const nowTimestampMs = nowDate.getTime()

  const weekends = Object.entries(groupedRaces)
    .map(([key, grandPrix]) => {
      const sortedEvents = [...grandPrix.events].sort((a, b) => new Date(a.date) - new Date(b.date))
      if (sortedEvents.length === 0) {
        return null
      }

      const firstEvent = sortedEvents[0]
      const lastEvent = sortedEvents[sortedEvents.length - 1]
      const startMs = getEventTimestampMs(firstEvent.date)
      const lastEventStartMs = getEventTimestampMs(lastEvent.date)

      return {
        key,
        grandPrix,
        firstEvent,
        lastEvent,
        startMs,
        currentWindowEndMs: lastEventStartMs + threeHoursInMs
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs)

  const currentWeekend = weekends.find(weekend => nowTimestampMs >= weekend.startMs && nowTimestampMs < weekend.currentWindowEndMs)
  if (currentWeekend) {
    return {
      mode: 'current',
      ...currentWeekend
    }
  }

  const nextWeekend = weekends.find(weekend => nowTimestampMs < weekend.startMs)
  if (nextWeekend) {
    return {
      mode: 'next',
      ...nextWeekend
    }
  }

  return null
}

function getNextWeekendEvent(featuredWeekend, nowDate = new Date()) {
  if (!featuredWeekend?.grandPrix?.events?.length) {
    return null
  }

  const threeHoursInMs = 3 * 60 * 60 * 1000
  const nowTimestampMs = nowDate.getTime()
  const sortedEvents = [...featuredWeekend.grandPrix.events].sort((a, b) => new Date(a.date) - new Date(b.date))

  const runningEvent = sortedEvents.find(event => {
    const eventStartTimestampMs = getEventTimestampMs(event.date)
    const eventEndTimestampMs = event.end_date
      ? getEventTimestampMs(event.end_date)
      : eventStartTimestampMs + threeHoursInMs

    return nowTimestampMs >= eventStartTimestampMs && nowTimestampMs < eventEndTimestampMs
  })

  if (runningEvent) {
    const runningEventEndTimestampMs = runningEvent.end_date
      ? getEventTimestampMs(runningEvent.end_date)
      : getEventTimestampMs(runningEvent.date) + threeHoursInMs

    return {
      event: runningEvent,
      isRunning: true,
      countdownTargetTimestampMs: runningEventEndTimestampMs
    }
  }

  const nextEvent = sortedEvents.find(event => getEventTimestampMs(event.date) > nowTimestampMs)
  if (nextEvent) {
    return {
      event: nextEvent,
      isRunning: false,
      countdownTargetTimestampMs: getEventTimestampMs(nextEvent.date)
    }
  }

  return null
}

function formatCountdown(durationMs) {
  if (durationMs <= 0) {
    return '00:00:00'
  }

  const totalSeconds = Math.floor(durationMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const hh = String(hours).padStart(2, '0')
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')

  if (days > 0) {
    return `${days}d ${hh}:${mm}:${ss}`
  }

  return `${hh}:${mm}:${ss}`
}

function getScrollbarWidth() {
  const measurementElement = document.createElement('div')
  measurementElement.style.width = '100px'
  measurementElement.style.height = '100px'
  measurementElement.style.overflow = 'scroll'
  measurementElement.style.position = 'absolute'
  measurementElement.style.top = '-9999px'
  document.body.appendChild(measurementElement)
  const scrollbarWidth = measurementElement.offsetWidth - measurementElement.clientWidth
  document.body.removeChild(measurementElement)
  return scrollbarWidth
}

// All available timezones from the runtime
const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC']
  }
})()

function App() {
  const [races, setRaces] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedGrandPrixKey, setSelectedGrandPrixKey] = useState(null)
  const [modalAnimationOrigin, setModalAnimationOrigin] = useState(null)
  const [isClosingGrandPrixModal, setIsClosingGrandPrixModal] = useState(false)
  const modalCloseTimerRef = useRef(null)
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false)
  const [isClosingSettingsModal, setIsClosingSettingsModal] = useState(false)
  const [settingsModalAnimationOrigin, setSettingsModalAnimationOrigin] = useState(null)
  const settingsModalCloseTimerRef = useRef(null)
  const [trackLayoutsByCountry, setTrackLayoutsByCountry] = useState({})
  const [failedTrackLayouts, setFailedTrackLayouts] = useState({})
  const [trackLayoutSources, setTrackLayoutSources] = useState({
    jsonUrl: DEFAULT_TRACK_LAYOUT_JSON_URL,
    svgFolderUrl: DEFAULT_TRACK_LAYOUT_SVG_FOLDER_URL
  })
  const [isAdminView, setIsAdminView] = useState(() => window.location.hash === '#admin')
  const [isDiscordView, setIsDiscordView] = useState(() => window.location.hash === '#discord')
  const [toasts, setToasts] = useState([])
  const [gpSearchQuery, setGpSearchQuery] = useState('')
  const [nowTick, setNowTick] = useState(() => new Date())
  const [timezone, setTimezone] = useState(() => {
    // Load timezone from localStorage, default to local timezone
    const saved = localStorage.getItem('f1-timezone')
    if (saved) return saved
    
    // Try to detect user's timezone
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return 'UTC'
    }
  })

  useEffect(() => {
    // Save timezone to localStorage when it changes
    localStorage.setItem('f1-timezone', timezone)
  }, [timezone])

  useEffect(() => {
    const timer = setInterval(() => {
      setNowTick(new Date())
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  const showToast = (message, type = 'success') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    
    // Auto dismiss after 5 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id))
    }, 5000)
  }

  const removeToast = (id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }

  useEffect(() => {
    const onHashChange = () => {
      setIsAdminView(window.location.hash === '#admin')
      setIsDiscordView(window.location.hash === '#discord')
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    fetchRaces()
  }, [])

  useEffect(() => {
    const fetchTrackLayouts = async () => {
      try {
        let jsonUrl = DEFAULT_TRACK_LAYOUT_JSON_URL
        let svgFolderUrl = DEFAULT_TRACK_LAYOUT_SVG_FOLDER_URL

        try {
          const configResponse = await axios.get('/api/public-config')
          jsonUrl = configResponse.data?.trackLayoutJsonUrl || jsonUrl
          svgFolderUrl = configResponse.data?.trackLayoutSvgFolderUrl || svgFolderUrl
        } catch {
          jsonUrl = import.meta.env.VITE_TRACK_LAYOUT_JSON_URL || jsonUrl
          svgFolderUrl = import.meta.env.VITE_TRACK_LAYOUT_SVG_FOLDER_URL || svgFolderUrl
        }

        setTrackLayoutSources({ jsonUrl, svgFolderUrl })
        const response = await axios.get(jsonUrl, { withCredentials: false })
        const countryLayoutMap = buildCountryLayoutMap(response.data)
        setTrackLayoutsByCountry(countryLayoutMap)
      } catch (error) {
        console.error('Error fetching track layouts:', error)
      }
    }

    fetchTrackLayouts()
  }, [])

  const fetchRaces = async () => {
    try {
      const response = await axios.get('/api/races')
      setRaces(response.data)
      setLoading(false)
    } catch (error) {
      console.error('Error fetching races:', error)
      setLoading(false)
    }
  }

  // Group races by Grand Prix (already processed by backend, just organize by GP)
  const groupRacesByGrandPrix = () => {
    const grouped = {}
    
    races.forEach(race => {
      // Use the already cleaned name from backend
      const gpName = race.name.trim()
      
      // Create a normalized key for grouping
      const groupKey = gpName
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s]/g, '')
        .trim()
      
      if (!grouped[groupKey]) {
        grouped[groupKey] = {
          name: gpName,
          location: race.location,
          city: race.city,
          circuit_name: race.circuit_name,
          events: []
        }
      }
      grouped[groupKey].events.push(race)
    })

    // Sort events within each GP by date
    Object.keys(grouped).forEach(gpKey => {
      grouped[gpKey].events.sort((a, b) => new Date(a.date) - new Date(b.date))
    })

    return grouped
  }

  const getEventTypeName = (type) => {
    switch(type) {
      case 'race': return 'Race'
      case 'qualifying': return 'Qualifying'
      case 'practice': return 'Practice'
      case 'sprint': return 'Sprint'
      case 'custom': return 'Custom'
      default: return type
    }
  }

  const openGrandPrixModal = (gpKey, originRect) => {
    if (modalCloseTimerRef.current) {
      clearTimeout(modalCloseTimerRef.current)
      modalCloseTimerRef.current = null
    }

    setIsClosingGrandPrixModal(false)

    if (originRect) {
      const viewportCenterX = window.innerWidth / 2
      const viewportCenterY = window.innerHeight / 2
      const originCenterX = originRect.left + originRect.width / 2
      const originCenterY = originRect.top + originRect.height / 2

      setModalAnimationOrigin({
        translateX: originCenterX - viewportCenterX,
        translateY: originCenterY - viewportCenterY
      })
    } else {
      setModalAnimationOrigin(null)
    }

    setSelectedGrandPrixKey(gpKey)
  }

  const closeGrandPrixModal = () => {
    if (!selectedGrandPrixKey || isClosingGrandPrixModal) {
      return
    }

    setIsClosingGrandPrixModal(true)

    modalCloseTimerRef.current = setTimeout(() => {
      setSelectedGrandPrixKey(null)
      setModalAnimationOrigin(null)
      setIsClosingGrandPrixModal(false)
      modalCloseTimerRef.current = null
    }, 208)
  }

  const openSettingsModal = (originRect) => {
    if (settingsModalCloseTimerRef.current) {
      clearTimeout(settingsModalCloseTimerRef.current)
      settingsModalCloseTimerRef.current = null
    }

    setIsClosingSettingsModal(false)

    if (originRect) {
      const viewportCenterX = window.innerWidth / 2
      const viewportCenterY = window.innerHeight / 2
      const originCenterX = originRect.left + originRect.width / 2
      const originCenterY = originRect.top + originRect.height / 2

      setSettingsModalAnimationOrigin({
        translateX: originCenterX - viewportCenterX,
        translateY: originCenterY - viewportCenterY
      })
    } else {
      setSettingsModalAnimationOrigin(null)
    }

    setIsSettingsModalOpen(true)
  }

  const closeSettingsModal = () => {
    if (!isSettingsModalOpen || isClosingSettingsModal) {
      return
    }

    setIsClosingSettingsModal(true)

    settingsModalCloseTimerRef.current = setTimeout(() => {
      setIsSettingsModalOpen(false)
      setSettingsModalAnimationOrigin(null)
      setIsClosingSettingsModal(false)
      settingsModalCloseTimerRef.current = null
    }, 208)
  }

  useEffect(() => {
    return () => {
      if (modalCloseTimerRef.current) {
        clearTimeout(modalCloseTimerRef.current)
      }

      if (settingsModalCloseTimerRef.current) {
        clearTimeout(settingsModalCloseTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!selectedGrandPrixKey && !isSettingsModalOpen) {
      return undefined
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (isSettingsModalOpen) {
          closeSettingsModal()
          return
        }

        closeGrandPrixModal()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedGrandPrixKey, isSettingsModalOpen, isClosingSettingsModal, isClosingGrandPrixModal])

  useEffect(() => {
    if (!selectedGrandPrixKey && !isSettingsModalOpen) {
      return undefined
    }

    const originalOverflow = document.body.style.overflow
    const originalPaddingRight = document.body.style.paddingRight
    const originalScrollbarCompensation = document.documentElement.style.getPropertyValue('--scrollbar-compensation')
    const visualScrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    const measuredScrollbarWidth = getScrollbarWidth()
    const scrollbarWidth = visualScrollbarWidth > 0 ? visualScrollbarWidth : measuredScrollbarWidth

    document.body.style.overflow = 'hidden'
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`
      document.documentElement.style.setProperty('--scrollbar-compensation', `${scrollbarWidth}px`)
    } else {
      document.documentElement.style.setProperty('--scrollbar-compensation', '0px')
    }

    return () => {
      document.body.style.overflow = originalOverflow
      document.body.style.paddingRight = originalPaddingRight
      if (originalScrollbarCompensation) {
        document.documentElement.style.setProperty('--scrollbar-compensation', originalScrollbarCompensation)
      } else {
        document.documentElement.style.removeProperty('--scrollbar-compensation')
      }
    }
  }, [selectedGrandPrixKey, isSettingsModalOpen])

  useEffect(() => {
    if (selectedGrandPrixKey || isSettingsModalOpen || isAdminView || isDiscordView) {
      return undefined
    }

    const applyPageScrollbarCompensation = () => {
      const shouldCompensate = document.documentElement.scrollHeight <= window.innerHeight

      if (!shouldCompensate) {
        document.body.style.paddingRight = ''
        document.documentElement.style.removeProperty('--scrollbar-compensation')
        return
      }

      const scrollbarWidth = getScrollbarWidth()
      if (scrollbarWidth > 0) {
        const compensation = `${scrollbarWidth}px`
        document.body.style.paddingRight = compensation
        document.documentElement.style.setProperty('--scrollbar-compensation', compensation)
      } else {
        document.body.style.paddingRight = ''
        document.documentElement.style.removeProperty('--scrollbar-compensation')
      }
    }

    applyPageScrollbarCompensation()
    window.addEventListener('resize', applyPageScrollbarCompensation)

    return () => {
      window.removeEventListener('resize', applyPageScrollbarCompensation)
    }
  }, [gpSearchQuery, races, selectedGrandPrixKey, isSettingsModalOpen, isAdminView, isDiscordView])

  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-GB', {
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone
    })
  }

  const formatEventDateRange = (event) => {
    if (!event) {
      return ''
    }

    if (event.end_date) {
      return `${formatDate(event.date)} - ${formatDate(event.end_date)}`
    }

    return formatDate(event.date)
  }

  const getEventDateRangeParts = (event) => {
    if (!event) {
      return []
    }

    if (event.end_date) {
      return [formatDate(event.date), formatDate(event.end_date)]
    }

    return [formatDate(event.date)]
  }

  const renderEventDateRange = (event) => {
    const dateParts = getEventDateRangeParts(event)

    if (dateParts.length <= 1) {
      return <span className="race-date">{dateParts[0] || ''}</span>
    }

    return (
      <span className="race-date is-range">
        {dateParts.map((datePart, index) => (
          <span key={`${datePart}-${index}`} className="race-date-part">{datePart}</span>
        ))}
      </span>
    )
  }

  const getRaceTypeEmoji = (type) => {
    switch(type) {
      case 'race': return '🏁'
      case 'qualifying': return '⏱️'
      case 'practice': return '🔧'
      case 'sprint': return '⚡'
      case 'custom': return '📝'
      default: return '📅'
    }
  }

  const getRaceTypeClass = (type) => {
    return `race-type-${type}`
  }

  const getTrackLayoutUrl = (location) => {
    const countryId = normalizeCountryId(location)
    const layoutId = trackLayoutsByCountry[countryId]

    if (!layoutId) {
      return null
    }

    const normalizedBaseUrl = trackLayoutSources.svgFolderUrl.replace(/\/+$/, '')
    return `${normalizedBaseUrl}/${layoutId}.svg`
  }

  const handleTrackLayoutImageError = (imageUrl) => {
    if (!imageUrl || failedTrackLayouts[imageUrl]) {
      return
    }

    setFailedTrackLayouts(prev => ({
      ...prev,
      [imageUrl]: true
    }))
  }

  if (loading && !isAdminView && !isDiscordView) {
    return <div className="loading">Loading...</div>
  }

  const groupedRaces = groupRacesByGrandPrix()
  const groupedRaceEntries = Object.entries(groupedRaces)
  const normalizedQueryTokens = normalizeSearchText(gpSearchQuery).split(' ').filter(Boolean)
  const filteredGrandPrixEntries = normalizedQueryTokens.length === 0
    ? groupedRaceEntries
    : groupedRaceEntries.filter(([, grandPrix]) => {
      const searchableText = normalizeSearchText([
        grandPrix.name,
        grandPrix.location,
        grandPrix.city,
        grandPrix.circuit_name
      ].join(' '))

      return normalizedQueryTokens.every(token => searchableText.includes(token))
    })

  const grandPrixCount = Object.keys(groupedRaces).length
  const selectedGrandPrix = selectedGrandPrixKey ? groupedRaces[selectedGrandPrixKey] : null
  const featuredWeekend = getFeaturedWeekend(groupedRaces, nowTick)
  const featuredEventState = featuredWeekend ? getNextWeekendEvent(featuredWeekend, nowTick) : null
  const featuredNextEvent = featuredEventState?.event || null
  const isFeaturedWeekendEventRunning = Boolean(featuredEventState?.isRunning)
  const featuredTrackLayoutUrl = featuredWeekend ? getTrackLayoutUrl(featuredWeekend.grandPrix.location) : null
  const featuredShowTrackLayout = featuredTrackLayoutUrl && !failedTrackLayouts[featuredTrackLayoutUrl]
  const nowTimestampMs = nowTick.getTime()
  const featuredCountdownMs = featuredEventState
    ? Math.max(0, featuredEventState.countdownTargetTimestampMs - nowTimestampMs)
    : 0
  const featuredCountdownText = featuredEventState ? formatCountdown(featuredCountdownMs) : 'Live'
  const modalAnimationStyle = {
    '--modal-origin-translate-x': `${modalAnimationOrigin?.translateX || 0}px`,
    '--modal-origin-translate-y': `${modalAnimationOrigin?.translateY || 0}px`
  }
  const settingsModalAnimationStyle = {
    '--modal-origin-translate-x': `${settingsModalAnimationOrigin?.translateX || 0}px`,
    '--modal-origin-translate-y': `${settingsModalAnimationOrigin?.translateY || 0}px`
  }

  if (isAdminView) {
    return (
      <AdminDashboard onBack={() => { window.location.hash = '' }} />
    )
  }

  if (isDiscordView) {
    return (
      <DiscordDashboard onBack={() => { window.location.hash = '' }} />
    )
  }

  return (
    <div className="app main-app">
      <div className="container">
        <div className="desktop-top-actions">
          <button
            className="settings-trigger desktop-discord-trigger"
            onClick={() => { window.location.hash = '#discord' }}
            aria-label="Discord dashboard"
          >
            Discord dashboard
          </button>
          <button
            className="settings-trigger desktop-settings-trigger"
            onClick={(event) => openSettingsModal(event.currentTarget.getBoundingClientRect())}
            aria-label="Settings"
          >
            Settings
          </button>
        </div>
        <button
          className="settings-trigger mobile-settings-trigger"
          onClick={(event) => openSettingsModal(event.currentTarget.getBoundingClientRect())}
          aria-label="Settings"
        >
          <img src={settingsIconPng} alt="" aria-hidden="true" className="mobile-settings-image" />
        </button>

        <header className="header">
          <div className="header-top">
            <h1>F1 Calendar</h1>
            <div className="gp-search">
              <input
                type="search"
                value={gpSearchQuery}
                onChange={(event) => setGpSearchQuery(event.target.value)}
                className="gp-search-input"
                placeholder="Search..."
                aria-label="Search Grand Prix"
                autoComplete="off"
              />
            </div>
          </div>
        </header>

        {featuredWeekend && (
          <section
            className={`featured-weekend-card ${
              featuredWeekend.mode === 'current'
                ? (isFeaturedWeekendEventRunning ? 'is-current-weekend' : '')
                : 'is-next-weekend'
            } ${gpSearchQuery.trim() ? 'is-hidden-on-mobile-when-searching' : ''}`}
            aria-live="polite"
            role="button"
            tabIndex={0}
            onClick={(event) => openGrandPrixModal(featuredWeekend.key, event.currentTarget.getBoundingClientRect())}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openGrandPrixModal(featuredWeekend.key, event.currentTarget.getBoundingClientRect())
              }
            }}
          >
            <div className="featured-weekend-main">
              <div className="featured-weekend-content">
                <p className={`featured-weekend-badge ${featuredWeekend.mode === 'current' ? 'is-current' : 'is-next'}`}>
                  {featuredWeekend.mode === 'current' ? 'Current weekend' : 'Next weekend'}
                </p>
                <h2 className="featured-weekend-title">{featuredWeekend.grandPrix.name}</h2>
                <p className="featured-weekend-meta">
                  {featuredWeekend.grandPrix.location || 'No location'}
                  {featuredWeekend.grandPrix.city ? `, ${featuredWeekend.grandPrix.city}` : ''}
                  {' • '}
                  {featuredWeekend.grandPrix.circuit_name || 'No circuit name'}
                </p>

                <div className={`featured-next-event-card race-item ${featuredNextEvent ? getRaceTypeClass(featuredNextEvent.type) : ''}`}>
                  <div className="race-content">
                    <div className="race-emoji">{featuredNextEvent ? getRaceTypeEmoji(featuredNextEvent.type) : '⏳'}</div>
                    <div className="race-info">
                      <div className="race-header">
                        <h4 className="race-name">{featuredNextEvent ? getEventTypeName(featuredNextEvent.type) : 'No more upcoming events this weekend'}</h4>
                        <div className="race-header-badges">
                          {featuredNextEvent && <span className="race-type">{featuredNextEvent.type}</span>}
                          {isFeaturedWeekendEventRunning && <span className="race-type race-type-live">Now live</span>}
                        </div>
                      </div>
                      <div className="race-details">
                        {featuredNextEvent ? (
                          <>
                            <div className="race-date-countdown-row">
                              {renderEventDateRange(featuredNextEvent)}
                              <span className="featured-next-countdown-value">{featuredCountdownText}</span>
                            </div>
                            {featuredNextEvent.description && <span className="race-weather-description">{featuredNextEvent.description}</span>}
                          </>
                        ) : (
                          <span className="race-date">The last event has already started.</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="featured-weekend-side">
                {featuredShowTrackLayout ? (
                  <img
                    src={featuredTrackLayoutUrl}
                    alt={`${featuredWeekend.grandPrix.name} track layout`}
                    className="featured-weekend-track-image"
                    loading="lazy"
                    onError={() => handleTrackLayoutImageError(featuredTrackLayoutUrl)}
                  />
                ) : (
                  <div className="featured-weekend-track-placeholder">Track layout unavailable</div>
                )}
              </div>
            </div>
          </section>
        )}

        <div className="gp-list-divider" aria-hidden="true">
          <span className="gp-list-divider-label">WEEKENDS</span>
          <span className="gp-list-divider-line" />
        </div>

        <div className="races-list">
          {grandPrixCount === 0 ? (
            <div className="no-races">
              <p>No races in the database yet.</p>
            </div>
          ) : filteredGrandPrixEntries.length === 0 ? (
            <div className="no-races">
              <p>No results found.</p>
            </div>
          ) : (
            filteredGrandPrixEntries.map(([gpKey, grandPrix]) => {
              const trackLayoutUrl = getTrackLayoutUrl(grandPrix.location)
              const showTrackLayout = trackLayoutUrl && !failedTrackLayouts[trackLayoutUrl]
              
              return (
                <article
                  key={gpKey}
                  className="race-card"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => openGrandPrixModal(gpKey, event.currentTarget.getBoundingClientRect())}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openGrandPrixModal(gpKey, event.currentTarget.getBoundingClientRect())
                    }
                  }}
                >
                  <div className="race-card-layout">
                    {showTrackLayout ? (
                      <img
                        src={trackLayoutUrl}
                        alt={`${grandPrix.name} track layout`}
                        className="race-card-track-image"
                        loading="lazy"
                        onError={() => handleTrackLayoutImageError(trackLayoutUrl)}
                      />
                    ) : (
                      <div className="race-card-layout-placeholder">Track layout unavailable</div>
                    )}
                  </div>
                  <div className="race-card-body">
                    <h3 className="race-card-title">{grandPrix.name}</h3>
                    <p className="race-card-location">
                      {grandPrix.location || 'No location'}
                      {grandPrix.city ? `, ${grandPrix.city}` : ''}
                    </p>
                    <p className="race-card-circuit">{grandPrix.circuit_name || 'No circuit name'}</p>
                    <span className="race-card-count">{grandPrix.events.length} events</span>
                  </div>
                </article>
              )
            })
          )}
        </div>

        {isSettingsModalOpen && (
          <div className={`gp-modal-overlay ${isClosingSettingsModal ? 'is-closing' : ''}`} onClick={closeSettingsModal}>
            <div
              className={`gp-modal settings-modal ${isClosingSettingsModal ? 'is-closing' : ''}`}
              style={settingsModalAnimationStyle}
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="gp-modal-header">
                <h2 id="settings-modal-title">Settings</h2>
                <button className="gp-modal-close" onClick={closeSettingsModal} aria-label="Close">×</button>
              </div>
              <div className="settings-modal-content">
                <div className="timezone-selector settings-timezone-selector">
                  <label htmlFor="settings-timezone-select">Timezone:</label>
                  <select
                    id="settings-timezone-select"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    className="timezone-select"
                  >
                    {TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>
                        {tz}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="secondary-button settings-discord-button mobile-only"
                  onClick={() => {
                    closeSettingsModal()
                    window.location.hash = '#discord'
                  }}
                >
                  Discord dashboard
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedGrandPrix && (
          <div className={`gp-modal-overlay ${isClosingGrandPrixModal ? 'is-closing' : ''}`} onClick={closeGrandPrixModal}>
            <div
              className={`gp-modal ${isClosingGrandPrixModal ? 'is-closing' : ''}`}
              style={modalAnimationStyle}
              role="dialog"
              aria-modal="true"
              aria-labelledby="gp-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="gp-modal-header">
                <h2 id="gp-modal-title">{selectedGrandPrix.name}</h2>
                <button className="gp-modal-close" onClick={closeGrandPrixModal} aria-label="Close">×</button>
              </div>
              <div className="gp-modal-events">
                {selectedGrandPrix.events.map((race) => (
                  <div key={race.id} className={`race-item ${getRaceTypeClass(race.type)}`}>
                    <div className="race-content">
                      <div className="race-emoji">{getRaceTypeEmoji(race.type)}</div>
                      <div className="race-info">
                        <div className="race-header">
                          <h4 className="race-name">{getEventTypeName(race.type)}</h4>
                          <span className="race-type">{race.type}</span>
                        </div>
                        <div className="race-details">
                          {renderEventDateRange(race)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <footer className="footer">
          <p>{grandPrixCount} Grand Prix • {races.length} events</p>
        </footer>
      </div>

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map(toast => (
          <Toast 
            key={toast.id} 
            message={toast.message} 
            type={toast.type} 
            onRemove={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </div>
  )
}

// Toast Component
function Toast({ message, type, onRemove }) {
  const [isHovered, setIsHovered] = useState(false)

  useEffect(() => {
    if (isHovered) return

    const timer = setTimeout(() => {
      onRemove()
    }, 5000)

    return () => clearTimeout(timer)
  }, [isHovered, onRemove])

  return (
    <div 
      className={`toast toast-${type}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="toast-content">
        <span className="toast-icon">
          {type === 'success' ? '✓' : '✕'}
        </span>
        <span className="toast-message">{message}</span>
      </div>
      <button className="toast-close" onClick={onRemove}>×</button>
    </div>
  )
}

export default App

function AdminDashboard({ onBack }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [customEvents, setCustomEvents] = useState([])
  const [form, setForm] = useState({
    name: '',
    location: '',
    date: '',
    end_date: '',
    type: 'custom',
    description: ''
  })
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  })

  useEffect(() => {
    checkAuth()
  }, [])

  useEffect(() => {
    if (isAuthenticated) {
      fetchCustomEvents()
    }
  }, [isAuthenticated])

  const checkAuth = async () => {
    try {
      await axios.get('/api/admin/me')
      setIsAuthenticated(true)
    } catch {
      setIsAuthenticated(false)
    }
  }

  const login = async (e) => {
    e.preventDefault()
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/admin/login', { username, password })
      setPassword('')
      setIsAuthenticated(true)
      setStatus('Login successful.')
    } catch (error) {
      setStatus('Login failed.')
    } finally {
      setIsLoading(false)
    }
  }

  const logout = async () => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/admin/logout')
      setIsAuthenticated(false)
      setCustomEvents([])
      setStatus('Logged out.')
    } catch {
      setStatus('Logout failed.')
    } finally {
      setIsLoading(false)
    }
  }

  const fetchCustomEvents = async () => {
    try {
      const response = await axios.get('/api/admin/custom-events')
      setCustomEvents(response.data)
    } catch (error) {
      setStatus('Failed to load custom events.')
    }
  }

  const createCustomEvent = async (e) => {
    e.preventDefault()
    setIsLoading(true)
    setStatus('')
    try {
      const payload = {
        ...form,
        date: form.date ? new Date(form.date).toISOString() : '',
        end_date: form.end_date ? new Date(form.end_date).toISOString() : null
      }
      await axios.post('/api/admin/custom-events', payload)
      setForm({ name: '', location: '', date: '', end_date: '', type: 'custom', description: '' })
      setStatus('Custom event added.')
      await fetchCustomEvents()
    } catch (error) {
      setStatus('Failed to add custom event.')
    } finally {
      setIsLoading(false)
    }
  }

  const deleteCustomEvent = async (id) => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.delete(`/api/admin/custom-events/${id}`)
      setStatus('Custom event deleted.')
      await fetchCustomEvents()
    } catch (error) {
      setStatus('Failed to delete custom event.')
    } finally {
      setIsLoading(false)
    }
  }

  const triggerSync = async () => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/admin/sync')
      setStatus('Calendar updated.')
    } catch (error) {
      setStatus('Failed to update calendar.')
    } finally {
      setIsLoading(false)
    }
  }

  const changePassword = async (e) => {
    e.preventDefault()
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setStatus('New passwords do not match.')
      return
    }
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/admin/change-password', {
        username,
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword
      })
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      setStatus('Password changed successfully.')
    } catch (error) {
      setStatus('Failed to change password.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="app admin-app">
      <div className="container">
        <header className="header">
          <div className="header-top">
            <h1>Admin Dashboard</h1>
            <button className="back-button" onClick={onBack}>Back to calendar</button>
          </div>
        </header>

        {!isAuthenticated ? (
          <form className="admin-card login-card" onSubmit={login}>
            <div className="login-hero">
              <span className="login-icon">🔒</span>
              <div>
                <h2>Sign in</h2>
                <p className="muted login-subtitle">Admin access for event management.</p>
              </div>
            </div>
            <div className="form-row">
              <label>Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
              />
            </div>
            <div className="form-row">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <button className="primary-button" type="submit" disabled={isLoading}>Sign in</button>
            {status && <p className="status-text">{status}</p>}
          </form>
        ) : (
          <div className="admin-grid">
            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Change password</h2>
              </div>
              <form onSubmit={changePassword}>
                <div className="form-row">
                  <label>Current password</label>
                  <input
                    type="password"
                    value={passwordForm.currentPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>New password (min 10 characters)</label>
                  <input
                    type="password"
                    value={passwordForm.newPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Confirm new password</label>
                  <input
                    type="password"
                    value={passwordForm.confirmPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                    required
                  />
                </div>
                <button className="secondary-button" type="submit" disabled={isLoading}>Save password</button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Admin actions</h2>
              </div>
              <button className="primary-button" onClick={triggerSync} disabled={isLoading}>Refresh calendar</button>
              <button className="secondary-button" onClick={logout} disabled={isLoading}>Sign out</button>
              {status && <p className="status-text">{status}</p>}
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Create custom event</h2>
              </div>
              <form onSubmit={createCustomEvent}>
                <div className="form-row">
                  <label>Name</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Custom event name"
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Location</label>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    placeholder="Budapest"
                  />
                </div>
                <div className="form-row">
                  <label>Date and time</label>
                  <input
                    type="datetime-local"
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>End date and time (optional)</label>
                  <input
                    type="datetime-local"
                    value={form.end_date}
                    onChange={(e) => setForm({ ...form, end_date: e.target.value })}
                  />
                </div>
                <div className="form-row">
                  <label>Type</label>
                  <select
                    value="custom"
                    disabled
                  >
                    <option value="custom">Custom Event</option>
                  </select>
                  <input
                    type="hidden"
                    value="custom"
                  />
                </div>
                <div className="form-row">
                  <label>Description</label>
                  <textarea
                    rows="3"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Optional note"
                  />
                </div>
                <button className="primary-button" type="submit" disabled={isLoading}>Save</button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Custom events</h2>
                <button className="ghost-button" onClick={fetchCustomEvents} disabled={isLoading}>Refresh</button>
              </div>
              {customEvents.length === 0 ? (
                <p className="muted">No custom events.</p>
              ) : (
                <div className="custom-events-list">
                  {customEvents.map(event => (
                    <div key={event.id} className="custom-event-item">
                      <div className="custom-event-info">
                        <strong>{event.name}</strong>
                        <span>{new Date(event.date).toLocaleString('en-GB', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        {event.end_date && <span>Ends: {new Date(event.end_date).toLocaleString('en-GB', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                        {event.location && <span>📍 {event.location}</span>}
                        {event.description && <span>{event.description}</span>}
                      </div>
                      <button
                        className="danger-button"
                        onClick={() => deleteCustomEvent(event.id)}
                        disabled={isLoading}
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
    </div>
  )
}

function DiscordDashboard({ onBack }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [user, setUser] = useState(null)
  const [adminGuilds, setAdminGuilds] = useState([])
  const [guildConfigs, setGuildConfigs] = useState({})
  const [status, setStatus] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isAuthLoading, setIsAuthLoading] = useState(true)
  const [isGuildsLoading, setIsGuildsLoading] = useState(false)
  const [selectedGuildId, setSelectedGuildId] = useState(null)
  const [channels, setChannels] = useState([])
  const [roles, setRoles] = useState([])
  const [notifications, setNotifications] = useState([])
  const [notificationEdits, setNotificationEdits] = useState({}) // Track edited event_types by notification id
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [newLeadMinutes, setNewLeadMinutes] = useState(60)
  const [selectedEventTypes, setSelectedEventTypes] = useState(['race', 'practice', 'qualifying', 'sprint', 'custom'])
  const [toasts, setToasts] = useState([])
  const [config, setConfig] = useState({ 
    channel_id: '', 
    lead_minutes: 60, 
    timezone: (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone
      } catch {
        return 'UTC'
      }
    })(), 
    role_id: '',
    role_map: {}
  })
  const [weatherConfig, setWeatherConfig] = useState({
    channel_id: '',
    enabled: false,
    race_day_lead_minutes: '',
    role_id: ''
  })

  const showToast = (message, type = 'success') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    
    // Auto dismiss after 5 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(toast => toast.id !== id))
    }, 5000)
  }

  const removeToast = (id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id))
  }

  useEffect(() => {
    checkAuth()
  }, [])

  useEffect(() => {
    if (isAuthenticated) {
      fetchAdminGuilds()
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (selectedGuildId) {
      fetchChannels(selectedGuildId)
      fetchRoles(selectedGuildId)
      fetchConfig(selectedGuildId)
      fetchWeatherConfig(selectedGuildId)
      fetchNotifications(selectedGuildId)
    }
  }, [selectedGuildId])

  useEffect(() => {
    if (config.channel_id && !weatherConfig.channel_id) {
      setWeatherConfig(prev => ({ ...prev, channel_id: config.channel_id }))
    }
  }, [config.channel_id, weatherConfig.channel_id])

  const checkAuth = async () => {
    setIsAuthLoading(true)
    try {
      const response = await axios.get('/api/discord/me')
      setUser(response.data)
      setIsAuthenticated(true)
    } catch {
      setIsAuthenticated(false)
    } finally {
      setIsAuthLoading(false)
    }
  }

  const fetchAdminGuilds = async () => {
    setIsGuildsLoading(true)
    try {
      const response = await axios.get('/api/discord/admin-guilds')
      setAdminGuilds(response.data)
    } catch {
      setStatus('Failed to load admin servers.')
    } finally {
      setIsGuildsLoading(false)
    }
  }

  const refreshAdminGuilds = async () => {
    setStatus('')
    await fetchAdminGuilds()
  }

  const fetchChannels = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/guilds/${guildId}/channels`)
      setChannels(response.data)
    } catch {
      setStatus('Failed to load channels.')
    }
  }

  const fetchRoles = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/guilds/${guildId}/roles`)
      setRoles(response.data)
    } catch {
      setStatus('Failed to load roles.')
    }
  }

  const fetchConfig = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/config/${guildId}`)
      if (response.data) {
        setConfig({
          channel_id: response.data.channel_id,
          lead_minutes: response.data.lead_minutes,
          timezone: response.data.timezone,
          role_id: response.data.role_id || '',
          role_map: response.data.role_map || {}
        })
        setGuildConfigs(prev => ({
          ...prev,
          [guildId]: response.data
        }))
      } else {
        setConfig({ 
          channel_id: '', 
          lead_minutes: 60, 
          timezone: (() => {
            try {
              return Intl.DateTimeFormat().resolvedOptions().timeZone
            } catch {
              return 'UTC'
            }
          })(), 
          role_id: '',
          role_map: {}
        })
        setGuildConfigs(prev => ({
          ...prev,
          [guildId]: null
        }))
      }
    } catch {
      setStatus('Failed to load settings.')
    }
  }

  const fetchWeatherConfig = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/weather-config/${guildId}`)
      if (response.data) {
        setWeatherConfig({
          channel_id: response.data.channel_id || config.channel_id || '',
          enabled: response.data.enabled ? true : false,
          race_day_lead_minutes: response.data.race_day_lead_minutes ?? '',
          role_id: response.data.role_id || ''
        })
      } else {
        setWeatherConfig({
          channel_id: config.channel_id || '',
          enabled: false,
          race_day_lead_minutes: '',
          role_id: ''
        })
      }
    } catch {
      setStatus('Failed to load weather notifications.')
    }
  }

  const fetchNotifications = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/notifications/${guildId}`)
      setNotifications(response.data)
      setNotificationEdits({}) // Clear edits when fetching
      setHasUnsavedChanges(false)
    } catch {
      setStatus('Failed to load notifications.')
    }
  }

  const addNotification = async () => {
    setIsLoading(true)
    try {
      await axios.post('/api/discord/notifications', {
        guild_id: selectedGuildId,
        lead_minutes: Number(newLeadMinutes),
        event_types: ['race', 'practice', 'qualifying', 'sprint', 'custom']
      })
      setNewLeadMinutes(60)
      await fetchNotifications(selectedGuildId)
      showToast('Notification added successfully!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to add notification.'
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const deleteNotification = async (id) => {
    setIsLoading(true)
    try {
      await axios.delete(`/api/discord/notifications/${id}`)
      await fetchNotifications(selectedGuildId)
      showToast('Notification deleted successfully!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to delete notification.'
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const handleNotificationEventTypeChange = (notificationId, eventType, isChecked) => {
    const currentEdits = notificationEdits[notificationId] || 
      (notifications.find(n => n.id === notificationId)?.event_types || [])
    
    let newEventTypes
    if (isChecked) {
      newEventTypes = [...currentEdits, eventType]
    } else {
      newEventTypes = currentEdits.filter(t => t !== eventType)
    }
    
    setNotificationEdits(prev => ({
      ...prev,
      [notificationId]: newEventTypes
    }))
    setHasUnsavedChanges(true)
  }

  const saveNotifications = async () => {
    setIsLoading(true)
    try {
      // Delete and recreate each modified notification
      for (const notificationId of Object.keys(notificationEdits)) {
        const notification = notifications.find(n => n.id === parseInt(notificationId))
        if (notification) {
          const newEventTypes = notificationEdits[notificationId]
          // Delete old
          await axios.delete(`/api/discord/notifications/${notificationId}`)
          // Recreate with new event_types
          await axios.post('/api/discord/notifications', {
            guild_id: selectedGuildId,
            lead_minutes: notification.lead_minutes,
            event_types: newEventTypes
          })
        }
      }
      await fetchNotifications(selectedGuildId)
      showToast('Notifications saved successfully!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to save notifications.'
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const saveConfig = async (e) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      await axios.post('/api/discord/config', {
        guild_id: selectedGuildId,
        channel_id: config.channel_id,
        lead_minutes: 60,
        timezone: config.timezone,
        role_id: config.role_id || null,
        role_map: config.role_map || {}
      })
      showToast('Settings saved successfully!', 'success')
      await fetchAdminGuilds()
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to save settings.'
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const saveWeatherConfig = async (e) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      await axios.post('/api/discord/weather-config', {
        guild_id: selectedGuildId,
        channel_id: weatherConfig.channel_id || config.channel_id,
        enabled: Boolean(weatherConfig.enabled),
        race_day_lead_minutes: weatherConfig.race_day_lead_minutes ? Number(weatherConfig.race_day_lead_minutes) : null,
        role_id: weatherConfig.role_id || null
      })
      showToast('Weather notification configured!', 'success')
      await fetchWeatherConfig(selectedGuildId)
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to save weather notification.'
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const sendWeatherTest = async () => {
    setIsLoading(true)
    try {
      await axios.post('/api/discord/weather-test', {
        guild_id: selectedGuildId
      })
      showToast('Weather test sent!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to send weather test.'
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const logout = async () => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/discord/logout')
      setIsAuthenticated(false)
      setUser(null)
      setAdminGuilds([])
      setGuildConfigs({})
      setSelectedGuildId(null)
      setStatus('Logged out.')
      showToast('Signed out successfully!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to sign out.'
      setStatus(errorMsg)
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  const handleInviteBot = async () => {
    try {
      const response = await axios.get('/api/discord/invite-url')
      window.open(response.data.url, '_blank')
    } catch {
      setStatus('Failed to invite the bot.')
    }
  }

  const handleTestNotification = async () => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/discord/test-notification', {
        guild_id: selectedGuildId
      })
      setStatus('Test notification sent!')
      showToast('Test notification sent successfully!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Failed to send test notification.'
      setStatus(errorMsg)
      showToast(errorMsg, 'error')
    } finally {
      setIsLoading(false)
    }
  }

  if (selectedGuildId) {
    const guild = adminGuilds.find(g => g.id === selectedGuildId)
    return (
      <div className="app admin-app">
        <div className="container">
          <header className="header">
            <div className="header-top">
                <h1>{guild?.name} - Settings</h1>
                <button className="back-button" onClick={() => setSelectedGuildId(null)}>Back to admin servers</button>
            </div>
          </header>

          <div className="admin-grid">
            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Notification settings</h2>
              </div>
              <form onSubmit={saveConfig}>
                <div className="form-row">
                  <label>Channel</label>
                  <select
                    value={config.channel_id}
                    onChange={(e) => setConfig({ ...config, channel_id: e.target.value })}
                    required
                  >
                    <option value="">Select a channel</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>#{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>Timezone</label>
                  <select
                    value={config.timezone}
                    onChange={(e) => setConfig({ ...config, timezone: e.target.value })}
                    required
                  >
                    {TIMEZONES.map((tz) => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>Roles by event type (optional)</label>
                  <div className="role-mapping-grid">
                    {['race', 'qualifying', 'practice', 'sprint', 'custom'].map((type) => (
                      <div key={type} className="role-mapping-item">
                        <span className="role-mapping-label">
                          {type === 'race' ? 'Race' : type === 'qualifying' ? 'Qualifying' : type === 'practice' ? 'Practice' : type === 'sprint' ? 'Sprint' : 'Custom'}
                        </span>
                        <select
                          value={config.role_map?.[type] || ''}
                          onChange={(e) => setConfig({
                            ...config,
                            role_map: {
                              ...(config.role_map || {}),
                              [type]: e.target.value
                            }
                          })}
                        >
                          <option value="">No role</option>
                          {roles
                            .filter(r => r.name !== '@everyone')
                            .sort((a, b) => b.position - a.position)
                            .map((r) => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
                <button className="primary-button" type="submit" disabled={isLoading}>Save base settings</button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>🌦️ Weather notifications</h2>
              </div>
              <p className="muted">Sends a 3-day forecast for the full race weekend after midnight on the first race day.</p>
              <form onSubmit={saveWeatherConfig}>
                <div className="form-row">
                  <label>Weather channel</label>
                  <select
                    value={weatherConfig.channel_id}
                    onChange={(e) => setWeatherConfig({ ...weatherConfig, channel_id: e.target.value })}
                    required
                    disabled={isLoading}
                  >
                    <option value="">Select a channel</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>#{c.name}</option>
                    ))}
                  </select>
                  <small className="muted" style={{ marginTop: '0.5rem', display: 'block' }}>
                    This should be a separate channel from race notifications.
                  </small>
                </div>
                <div className="form-row">
                  <label>Enabled</label>
                  <label className="checkbox-label" style={{ marginTop: '0.35rem' }}>
                    <input
                      type="checkbox"
                      checked={weatherConfig.enabled}
                      onChange={(e) => setWeatherConfig({ ...weatherConfig, enabled: e.target.checked })}
                      disabled={isLoading}
                    />
                    <span className="checkbox-text">Enable weekend weather notifications</span>
                  </label>
                </div>
                <div className="form-row">
                  <label>Role mention (optional)</label>
                  <select
                    value={weatherConfig.role_id}
                    onChange={(e) => setWeatherConfig({ ...weatherConfig, role_id: e.target.value })}
                    disabled={isLoading}
                  >
                    <option value="">No role</option>
                    {roles
                      .filter(r => r.name !== '@everyone')
                      .sort((a, b) => b.position - a.position)
                      .map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                  </select>
                  <small className="muted" style={{ marginTop: '0.5rem', display: 'block' }}>
                    Selected role is mentioned in weather notifications.
                  </small>
                </div>
                <div className="form-row">
                  <label>Race-day notification (minutes)</label>
                  <input
                    type="number"
                    min="5"
                    max="1440"
                    placeholder="Optional"
                    value={weatherConfig.race_day_lead_minutes}
                    onChange={(e) => setWeatherConfig({ ...weatherConfig, race_day_lead_minutes: e.target.value })}
                    disabled={isLoading}
                  />
                  <small className="muted" style={{ marginTop: '0.5rem', display: 'block' }}>
                    Minutes before the first race on event day to send a weather alert (5-1440). Leave empty to disable.
                  </small>
                </div>
                <button className="primary-button" type="submit" disabled={isLoading}>
                  Save weather notification
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={sendWeatherTest}
                  disabled={isLoading}
                >
                  Send weather test now
                </button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>⏰ Notification timing</h2>
              </div>
              {notifications.length === 0 && (
                <p className="muted">Add multiple notifications for different times (for example 5, 10, 30 minutes before an event).</p>
              )}
              
              <div className="notifications-list">
                {notifications.length === 0 ? (
                  <p className="muted">No notifications configured yet.</p>
                ) : (
                  notifications.map((notif) => (
                    <div key={notif.id} className="notification-item-expanded">
                      <div className="notification-header">
                        <div className="notification-info">
                          <span className="notification-time">
                            {notif.lead_minutes === 0 ? 'At event start' : `${notif.lead_minutes} minutes before`}
                          </span>
                        </div>
                        <button
                          className="danger-button"
                          onClick={() => deleteNotification(notif.id)}
                          disabled={isLoading}
                        >
                          Delete
                        </button>
                      </div>
                      <div className="notification-types">
                        <span className="notification-types-label">Types:</span>
                        <div className="event-type-checkboxes">
                          {['race', 'practice', 'qualifying', 'sprint', 'custom'].map(type => {
                            const eventTypes = notificationEdits[notif.id] || notif.event_types || []
                            return (
                              <label key={type} className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={eventTypes.includes(type)}
                                  onChange={(e) => handleNotificationEventTypeChange(notif.id, type, e.target.checked)}
                                />
                                <span className="checkbox-text">{type === 'practice' ? 'Practice' : type === 'qualifying' ? 'Qualifying' : type === 'sprint' ? 'Sprint' : type === 'race' ? 'Race' : 'Custom'}</span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {hasUnsavedChanges && (
                <div className="unsaved-changes-section">
                  <div className="unsaved-changes-message">
                    <span className="unsaved-changes-icon">⚠️</span>
                    <span className="unsaved-changes-text">Changes are not saved</span>
                  </div>
                  <button
                    className="unsaved-changes-button"
                    onClick={saveNotifications}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Saving...' : 'Save changes'}
                  </button>
                </div>
              )}

              <div className="add-notification">
                <div className="form-row">
                  <label>Notification timing (minutes)</label>
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    value={newLeadMinutes}
                    onChange={(e) => setNewLeadMinutes(e.target.value)}
                    placeholder="e.g. 5"
                  />
                  <small className="muted" style={{ marginTop: '0.5rem', display: 'block' }}>
                    Example: <strong>5 minutes</strong> → alert 5 minutes before the event, <strong>0 minutes</strong> → alert at start time
                  </small>
                </div>
                <button 
                  className="secondary-button" 
                  onClick={addNotification}
                  disabled={isLoading}
                >
                  Add notification
                </button>
              </div>
              
              <button 
                className="primary-button" 
                onClick={handleTestNotification}
                disabled={isLoading}
                style={{ marginTop: '1rem' }}
              >
                Send test notification
              </button>
            </div>
          </div>
        </div>

        {/* Toast Notifications */}
        <div className="toast-container">
          {toasts.map(toast => (
            <Toast 
              key={toast.id} 
              message={toast.message} 
              type={toast.type} 
              onRemove={() => removeToast(toast.id)}
            />
          ))}
        </div>
      </div>
    )
  }

  if (isAuthLoading) {
    return (
      <div className="app admin-app">
        <div className="container">
          <header className="header">
            <div className="header-top">
              <h1>Discord Dashboard</h1>
              <button className="back-button" onClick={onBack}>Back to calendar</button>
            </div>
          </header>
          <div className="admin-card" style={{ textAlign: 'center', padding: '3rem' }}>
            <p className="muted">Loading...</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app admin-app">
      <div className="container">
        <header className="header">
          <div className="header-top">
            <h1>Discord Dashboard</h1>
            <button className="back-button" onClick={onBack}>Back to calendar</button>
          </div>
        </header>

        {!isAuthenticated ? (
          <div className="admin-card login-card discord-login-card">
            <div className="login-hero">
              <span className="login-icon">💬</span>
              <div>
                <h2>Discord sign in</h2>
                <p className="muted login-subtitle">Sign in with Discord to configure bot notifications.</p>
              </div>
            </div>
            <a className="primary-button" href="/api/discord/login">Sign in with Discord</a>
          </div>
        ) : (
          <div className="admin-grid">
            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Account</h2>
              </div>
              <div className="discord-user-profile">
                {user?.avatarUrl && (
                  <img src={user.avatarUrl} alt={user.username} className="discord-user-avatar" />
                )}
                <p><strong>{user?.username}</strong></p>
              </div>
              <button className="secondary-button" onClick={logout} disabled={isLoading}>Sign out</button>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>🤖 Invite bot</h2>
              </div>
              <p className="muted">Click the button below to invite the bot to your servers.</p>
              <button 
                className="primary-button" 
                onClick={handleInviteBot}
                disabled={isLoading}
              >
                Add bot to Discord server
              </button>
              {status && <p className="status-text">{status}</p>}
            </div>

            <div className="admin-card admin-card-full-width">
              <div className="admin-card-header">
                <h2>📋 Server management</h2>
                <button
                  className="secondary-button"
                  onClick={refreshAdminGuilds}
                  disabled={isGuildsLoading || isLoading}
                >
                  Refresh
                </button>
              </div>
              {isGuildsLoading ? (
                <div className="loading-container">
                  <div className="spinner"></div>
                  <p className="muted">Loading servers...</p>
                </div>
              ) : adminGuilds.length === 0 ? (
                <p className="muted">No servers found where you have admin rights and the bot is present.</p>
              ) : (
                <div className="guilds-grid">
                  {adminGuilds.map((guild) => (
                    <div key={guild.id} className="guild-card">
                      <div className="guild-banner">
                        {guild.icon ? (
                          <img 
                            src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`} 
                            alt={guild.name} 
                            className="guild-avatar" 
                          />
                        ) : (
                          <div className="guild-avatar-placeholder">
                            {guild.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div className="guild-card-content">
                        <h3 className="guild-card-name">{guild.name}</h3>
                        <button
                          className="guild-dashboard-button"
                          onClick={() => setSelectedGuildId(guild.id)}
                          disabled={isLoading}
                        >
                          Open dashboard
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map(toast => (
          <Toast 
            key={toast.id} 
            message={toast.message} 
            type={toast.type} 
            onRemove={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </div>
  )
}
