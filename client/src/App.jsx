import { useState, useEffect } from 'react'
import axios from 'axios'
import './App.css'

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
  const [expandedWeekends, setExpandedWeekends] = useState({})
  const [trackLayoutsByCountry, setTrackLayoutsByCountry] = useState({})
  const [failedTrackLayouts, setFailedTrackLayouts] = useState({})
  const [trackLayoutSources, setTrackLayoutSources] = useState({
    jsonUrl: DEFAULT_TRACK_LAYOUT_JSON_URL,
    svgFolderUrl: DEFAULT_TRACK_LAYOUT_SVG_FOLDER_URL
  })
  const [isAdminView, setIsAdminView] = useState(() => window.location.hash === '#admin')
  const [isDiscordView, setIsDiscordView] = useState(() => window.location.hash === '#discord')
  const [toasts, setToasts] = useState([])
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

  const toggleWeekend = (gpKey) => {
    setExpandedWeekends(prev => ({
      ...prev,
      [gpKey]: !prev[gpKey]
    }))
  }

  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('hu-HU', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone
    })
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
    return <div className="loading">Betöltés...</div>
  }

  const groupedRaces = groupRacesByGrandPrix()
  const grandPrixCount = Object.keys(groupedRaces).length

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
    <div className="app">
      <div className="container">
        <header className="header">
          <div className="header-top">
            <h1>🏎️ F1 Calendar 2026</h1>
            <div className="header-actions">
              <button className="secondary-button" onClick={() => { window.location.hash = '#discord' }}>Discord dashboard</button>
            </div>
            <div className="timezone-selector">
              <label htmlFor="timezone-select">Időzóna: </label>
              <select
                id="timezone-select"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="timezone-select"
              >
                {TIMEZONES.map(tz => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </header>

        <div className="races-list">
          {grandPrixCount === 0 ? (
            <div className="no-races">
              <p>Még nincsenek versenyek az adatbázisban.</p>
            </div>
          ) : (
            Object.entries(groupedRaces).map(([gpKey, grandPrix]) => {
              const isExpanded = expandedWeekends[gpKey]
              const trackLayoutUrl = getTrackLayoutUrl(grandPrix.location)
              const showTrackLayout = trackLayoutUrl && !failedTrackLayouts[trackLayoutUrl]
              
              return (
                <div key={gpKey} className="weekend-group">
                  <div 
                    className="weekend-header"
                    onClick={() => toggleWeekend(gpKey)}
                  >
                    <div className="weekend-info">
                      <h3 className="weekend-name">🏁 {grandPrix.name}</h3>
                      <div className="weekend-location-info">
                        {grandPrix.location && <span className="weekend-location">📍 {grandPrix.location}{grandPrix.city ? `, ${grandPrix.city}` : ''}</span>}
                        {grandPrix.circuit_name && <span className="weekend-circuit">🏎️ {grandPrix.circuit_name}</span>}
                      </div>
                      <span className="weekend-count">{grandPrix.events.length} esemény</span>
                    </div>
                    <div className="weekend-toggle">
                      <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
                    </div>
                  </div>
                  
                  {isExpanded && (
                    <div className="weekend-events">
                      {showTrackLayout && (
                        <div className="track-layout-card">
                          <img
                            src={trackLayoutUrl}
                            alt={`${grandPrix.name} track layout`}
                            className="track-layout-image"
                            loading="lazy"
                            onError={() => handleTrackLayoutImageError(trackLayoutUrl)}
                          />
                        </div>
                      )}
                      {grandPrix.events.map((race) => (
                        <div key={race.id} className={`race-item ${getRaceTypeClass(race.type)}`}>
                          <div className="race-content">
                            <div className="race-emoji">{getRaceTypeEmoji(race.type)}</div>
                            <div className="race-info">
                              <div className="race-header">
                                <h4 className="race-name">{getEventTypeName(race.type)}</h4>
                                <span className="race-type">{race.type}</span>
                              </div>
                              <div className="race-details">
                                <span className="race-date">{formatDate(race.date)}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <footer className="footer">
          <p>{grandPrixCount} Grand Prix • {races.length} esemény</p>
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
      setStatus('Sikeres bejelentkezés.')
    } catch (error) {
      setStatus('Sikertelen bejelentkezés.')
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
      setStatus('Kiléptél.')
    } catch {
      setStatus('Nem sikerült kijelentkezni.')
    } finally {
      setIsLoading(false)
    }
  }

  const fetchCustomEvents = async () => {
    try {
      const response = await axios.get('/api/admin/custom-events')
      setCustomEvents(response.data)
    } catch (error) {
      setStatus('Nem sikerült betölteni a custom eventeket.')
    }
  }

  const createCustomEvent = async (e) => {
    e.preventDefault()
    setIsLoading(true)
    setStatus('')
    try {
      const payload = {
        ...form,
        date: form.date ? new Date(form.date).toISOString() : ''
      }
      await axios.post('/api/admin/custom-events', payload)
      setForm({ name: '', location: '', date: '', type: 'custom', description: '' })
      setStatus('Custom event hozzáadva.')
      await fetchCustomEvents()
    } catch (error) {
      setStatus('Nem sikerült hozzáadni a custom eventet.')
    } finally {
      setIsLoading(false)
    }
  }

  const deleteCustomEvent = async (id) => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.delete(`/api/admin/custom-events/${id}`)
      setStatus('Custom event törölve.')
      await fetchCustomEvents()
    } catch (error) {
      setStatus('Nem sikerült törölni a custom eventet.')
    } finally {
      setIsLoading(false)
    }
  }

  const triggerSync = async () => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/admin/sync')
      setStatus('Naptár frissítve.')
    } catch (error) {
      setStatus('Nem sikerült frissíteni a naptárat.')
    } finally {
      setIsLoading(false)
    }
  }

  const changePassword = async (e) => {
    e.preventDefault()
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setStatus('Az új jelszavak nem egyeznek.')
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
      setStatus('Jelszó sikeresen megváltoztatva.')
    } catch (error) {
      setStatus('Nem sikerült megváltoztatni a jelszót.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="app admin-app">
      <div className="container">
        <header className="header">
          <div className="header-top">
            <h1>🔒 Admin Dashboard</h1>
            <button className="back-button" onClick={onBack}>Vissza a naptárhoz</button>
          </div>
        </header>

        {!isAuthenticated ? (
          <form className="admin-card login-card" onSubmit={login}>
            <div className="login-hero">
              <span className="login-icon">🔒</span>
              <div>
                <h2>Bejelentkezés</h2>
                <p className="muted login-subtitle">Admin hozzáférés az események kezeléséhez.</p>
              </div>
            </div>
            <div className="form-row">
              <label>Felhasználónév</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
              />
            </div>
            <div className="form-row">
              <label>Jelszó</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <button className="primary-button" type="submit" disabled={isLoading}>Bejelentkezés</button>
            {status && <p className="status-text">{status}</p>}
          </form>
        ) : (
          <div className="admin-grid">
            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Jelszó változtatás</h2>
              </div>
              <form onSubmit={changePassword}>
                <div className="form-row">
                  <label>Jelenlegi jelszó</label>
                  <input
                    type="password"
                    value={passwordForm.currentPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Új jelszó (min 10 karakter)</label>
                  <input
                    type="password"
                    value={passwordForm.newPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Új jelszó megerősítése</label>
                  <input
                    type="password"
                    value={passwordForm.confirmPassword}
                    onChange={(e) => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                    required
                  />
                </div>
                <button className="secondary-button" type="submit" disabled={isLoading}>Jelszó mentése</button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Admin műveletek</h2>
              </div>
              <button className="primary-button" onClick={triggerSync} disabled={isLoading}>Naptár frissítése</button>
              <button className="secondary-button" onClick={logout} disabled={isLoading}>Kijelentkezés</button>
              {status && <p className="status-text">{status}</p>}
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Custom Event létrehozása</h2>
              </div>
              <form onSubmit={createCustomEvent}>
                <div className="form-row">
                  <label>Név</label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Saját event neve"
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Helyszín</label>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    placeholder="Budapest"
                  />
                </div>
                <div className="form-row">
                  <label>Dátum és idő</label>
                  <input
                    type="datetime-local"
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-row">
                  <label>Típus</label>
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
                  <label>Leírás</label>
                  <textarea
                    rows="3"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Opcionális megjegyzés"
                  />
                </div>
                <button className="primary-button" type="submit" disabled={isLoading}>Mentés</button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Custom Eventek</h2>
                <button className="ghost-button" onClick={fetchCustomEvents} disabled={isLoading}>Frissítés</button>
              </div>
              {customEvents.length === 0 ? (
                <p className="muted">Nincs custom event.</p>
              ) : (
                <div className="custom-events-list">
                  {customEvents.map(event => (
                    <div key={event.id} className="custom-event-item">
                      <div className="custom-event-info">
                        <strong>{event.name}</strong>
                        <span>{new Date(event.date).toLocaleString('hu-HU')}</span>
                        {event.location && <span>📍 {event.location}</span>}
                        {event.description && <span>{event.description}</span>}
                      </div>
                      <button
                        className="danger-button"
                        onClick={() => deleteCustomEvent(event.id)}
                        disabled={isLoading}
                      >
                        Törlés
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
    enabled: false,
    race_day_lead_minutes: ''
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
      setStatus('Nem sikerült betölteni az admin szervereket.')
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
      setStatus('Nem sikerült betölteni a csatornákat.')
    }
  }

  const fetchRoles = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/guilds/${guildId}/roles`)
      setRoles(response.data)
    } catch {
      setStatus('Nem sikerült betölteni a szerepköröket.')
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
      setStatus('Nem sikerült betölteni a beállítást.')
    }
  }

  const fetchWeatherConfig = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/weather-config/${guildId}`)
      if (response.data) {
        setWeatherConfig({
          enabled: response.data.enabled ? true : false,
          race_day_lead_minutes: response.data.race_day_lead_minutes ?? ''
        })
      } else {
        setWeatherConfig({ enabled: false, race_day_lead_minutes: '' })
      }
    } catch {
      setStatus('Nem sikerült betölteni az időjárás értesítéseket.')
    }
  }

  const fetchNotifications = async (guildId) => {
    try {
      const response = await axios.get(`/api/discord/notifications/${guildId}`)
      setNotifications(response.data)
      setNotificationEdits({}) // Clear edits when fetching
      setHasUnsavedChanges(false)
    } catch {
      setStatus('Nem sikerült betölteni az értesítéseket.')
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
      showToast('Értesítés sikeresen hozzáadva!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült hozzáadni az értesítést.'
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
      showToast('Értesítés sikeresen törölve!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült törölni az értesítést.'
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
      showToast('Értesítések sikeresen elmentve!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült elmenteni az értesítéseket.'
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
        lead_minutes: 60, // Default, már nem használt
        timezone: config.timezone,
        role_id: config.role_id || null,
        role_map: config.role_map || {}
      })
      showToast('Beállítások sikeresen elmentve!', 'success')
      await fetchAdminGuilds()
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült elmenteni a beállítást.'
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
        enabled: Boolean(weatherConfig.enabled),
        race_day_lead_minutes: weatherConfig.race_day_lead_minutes ? Number(weatherConfig.race_day_lead_minutes) : null
      })
      showToast('Időjárás értesítés beállítva!', 'success')
      await fetchWeatherConfig(selectedGuildId)
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült menteni az időjárás értesítést.'
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
      showToast('Időjárás teszt elküldve!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült elküldeni az időjárás tesztet.'
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
      setStatus('Kiléptél.')
      showToast('Sikeresen kijelentkeztél!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült kijelentkezni.'
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
      setStatus('Nem sikerült meghívni a botot.')
    }
  }

  const handleTestNotification = async () => {
    setIsLoading(true)
    setStatus('')
    try {
      await axios.post('/api/discord/test-notification', {
        guild_id: selectedGuildId
      })
      setStatus('Test értesítés elküldve!')
      showToast('Test értesítés sikeresen elküldve!', 'success')
    } catch (error) {
      const errorMsg = error.response?.data?.error || 'Nem sikerült elküldeni a test értesítést.'
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
              <h1>⚙️ {guild?.name} - Beállítás</h1>
              <button className="back-button" onClick={() => setSelectedGuildId(null)}>Vissza az admin szerverekhez</button>
            </div>
          </header>

          <div className="admin-grid">
            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Értesítés beállítás</h2>
              </div>
              <form onSubmit={saveConfig}>
                <div className="form-row">
                  <label>Csatorna</label>
                  <select
                    value={config.channel_id}
                    onChange={(e) => setConfig({ ...config, channel_id: e.target.value })}
                    required
                  >
                    <option value="">Válassz csatornát</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>#{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-row">
                  <label>Időzóna</label>
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
                  <label>Szerepkörök típusonként (opcionális)</label>
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
                          <option value="">Nincs szerepkör</option>
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
                <button className="primary-button" type="submit" disabled={isLoading}>Alapbeállítások mentése</button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>🌦️ Időjárás értesítés</h2>
              </div>
              <p className="muted">Az első verseny napjának éjféle után elküldi a teljes versenyhétvégére szóló 3 napos előrejelzést.</p>
              <form onSubmit={saveWeatherConfig}>
                <div className="form-row">
                  <label>Aktív</label>
                  <label className="checkbox-label" style={{ marginTop: '0.35rem' }}>
                    <input
                      type="checkbox"
                      checked={weatherConfig.enabled}
                      onChange={(e) => setWeatherConfig({ ...weatherConfig, enabled: e.target.checked })}
                      disabled={isLoading}
                    />
                    <span className="checkbox-text">Hétvégés időjárás értesítés bekapcsolása</span>
                  </label>
                </div>
                <div className="form-row">
                  <label>Verseny napi értesítés (perc)</label>
                  <input
                    type="number"
                    min="5"
                    max="1440"
                    placeholder="Opcionális"
                    value={weatherConfig.race_day_lead_minutes}
                    onChange={(e) => setWeatherConfig({ ...weatherConfig, race_day_lead_minutes: e.target.value })}
                    disabled={isLoading}
                  />
                  <small className="muted" style={{ marginTop: '0.5rem', display: 'block' }}>
                    Az esemény napján az első verseny előtt hány perccel küldjön időjárás értesítést (5-1440 perc). Hagyd üresen a kikapcsoláshoz.
                  </small>
                </div>
                <button className="primary-button" type="submit" disabled={isLoading}>
                  Időjárás értesítés mentése
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={sendWeatherTest}
                  disabled={isLoading}
                >
                  Időjárás teszt küldése most
                </button>
              </form>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>⏰ Értesítések időzítése</h2>
              </div>
              {notifications.length === 0 && (
                <p className="muted">Adj hozzá több értesítést különböző időpontokra (pl. esemény előtt 5, 10, 30 perc).</p>
              )}
              
              <div className="notifications-list">
                {notifications.length === 0 ? (
                  <p className="muted">Még nincs értesítés beállítva.</p>
                ) : (
                  notifications.map((notif) => (
                    <div key={notif.id} className="notification-item-expanded">
                      <div className="notification-header">
                        <div className="notification-info">
                          <span className="notification-time">
                            {notif.lead_minutes === 0 ? 'Esemény kezdetekor' : `${notif.lead_minutes} perccel előtte`}
                          </span>
                        </div>
                        <button
                          className="danger-button"
                          onClick={() => deleteNotification(notif.id)}
                          disabled={isLoading}
                        >
                          Törlés
                        </button>
                      </div>
                      <div className="notification-types">
                        <span className="notification-types-label">Típusok:</span>
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
                    <span className="unsaved-changes-text">Változások nincsenek elmentve</span>
                  </div>
                  <button
                    className="unsaved-changes-button"
                    onClick={saveNotifications}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Folyamatban...' : 'Változások mentése'}
                  </button>
                </div>
              )}

              <div className="add-notification">
                <div className="form-row">
                  <label>Értesítés időzítése (perc)</label>
                  <input
                    type="number"
                    min="0"
                    max="1440"
                    value={newLeadMinutes}
                    onChange={(e) => setNewLeadMinutes(e.target.value)}
                    placeholder="pl. 5"
                  />
                  <small className="muted" style={{ marginTop: '0.5rem', display: 'block' }}>
                    Például: <strong>5 perc</strong> → értesítés 5 perccel az esemény előtt, <strong>0 perc</strong> → értesítés az induláskor
                  </small>
                </div>
                <button 
                  className="secondary-button" 
                  onClick={addNotification}
                  disabled={isLoading}
                >
                  Értesítés hozzáadása
                </button>
              </div>
              
              <button 
                className="primary-button" 
                onClick={handleTestNotification}
                disabled={isLoading}
                style={{ marginTop: '1rem' }}
              >
                Test értesítés küldése
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
              <h1>💬 Discord Dashboard</h1>
              <button className="back-button" onClick={onBack}>Vissza a naptárhoz</button>
            </div>
          </header>
          <div className="admin-card" style={{ textAlign: 'center', padding: '3rem' }}>
            <p className="muted">Betöltés...</p>
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
            <h1>💬 Discord Dashboard</h1>
            <button className="back-button" onClick={onBack}>Vissza a naptárhoz</button>
          </div>
        </header>

        {!isAuthenticated ? (
          <div className="admin-card login-card discord-login-card">
            <div className="login-hero">
              <span className="login-icon">💬</span>
              <div>
                <h2>Discord bejelentkezés</h2>
                <p className="muted login-subtitle">Jelentkezz be Discorddal, hogy beállítsd a bot értesítéseket.</p>
              </div>
            </div>
            <a className="primary-button" href="/api/discord/login">Belépés Discorddal</a>
          </div>
        ) : (
          <div className="admin-grid">
            <div className="admin-card">
              <div className="admin-card-header">
                <h2>Fiók</h2>
              </div>
              <div className="discord-user-profile">
                {user?.avatarUrl && (
                  <img src={user.avatarUrl} alt={user.username} className="discord-user-avatar" />
                )}
                <p><strong>{user?.username}</strong></p>
              </div>
              <button className="secondary-button" onClick={logout} disabled={isLoading}>Kijelentkezés</button>
            </div>

            <div className="admin-card">
              <div className="admin-card-header">
                <h2>🤖 Bot meghívása</h2>
              </div>
              <p className="muted">Kattints az alábbi gombra, hogy meghívd a botot a szervereidre.</p>
              <button 
                className="primary-button" 
                onClick={handleInviteBot}
                disabled={isLoading}
              >
                Bot hozzáadása a Discord szerverhez
              </button>
              {status && <p className="status-text">{status}</p>}
            </div>

            <div className="admin-card admin-card-full-width">
              <div className="admin-card-header">
                <h2>📋 Szerverek kezelése</h2>
                <button
                  className="secondary-button"
                  onClick={refreshAdminGuilds}
                  disabled={isGuildsLoading || isLoading}
                >
                  Frissítés
                </button>
              </div>
              {isGuildsLoading ? (
                <div className="loading-container">
                  <div className="spinner"></div>
                  <p className="muted">Szerverek betöltése...</p>
                </div>
              ) : adminGuilds.length === 0 ? (
                <p className="muted">Nincs olyan szerver, ahol admin jogokkal rendelkeznél és a bot benne lenne.</p>
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
                          Ugrás a dashboardra
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
