/* ============================================
   LE JEU DES HEURES — APP LOGIC (WITH SUPABASE)
   ============================================ */

(() => {
    'use strict';

    // ---- Supabase backend (hardcoded for shared multi-player play) ----
    const DEFAULT_SUPABASE_URL = 'https://byippbemdlbhybcbuviv.supabase.co';
    const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aXBwYmVtZGxiaHliY2J1dml2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDgwNTYsImV4cCI6MjA4OTU4NDA1Nn0.HN2AkClZd15ZkJftwbWBk7qFhBlNWRs9l4IRMSP2VQ0';

    // ---- Saison en cours ----
    // La saison 1 est la saison précédente (16 épisodes, conservée en base).
    // Le classement est filtré par saison : on repart de zéro.
    const CURRENT_SEASON = 2;
    const SEASON_LABEL = 'ALL STARS';

    // ---- State ----
    const state = {
        bets: [],           // { id, name, time (HH:MM string), minutes (minute de jeu), color }
        gameEnded: false,
        endTime: null,      // minute de jeu (voir timeToMinutes)
        endTimeStr: null,
        season: CURRENT_SEASON,
        episodeNumber: 1,   // Default episode number
        episodeId: null,    // Supabase episode UUID
        multiplier: 1,      // coefficient de l'épisode (épreuves reines)
        isSupabaseConnected: false,
        dbTimeOffset: 0,    // Offset between client time and DB time in milliseconds
        betCode: null       // 4-digit code required to submit a bet (null = no code required)
    };

    // ---- Supabase Client Instantiation ----
    let supabase = null;

    // ---- Dirty flags for optimized rendering ----
    let _renderDirty = true;     // Whether player list / timeline needs full re-render
    let _lastInvalidatedSet = ''; // Track which bets are invalidated to detect changes

    // ---- Sync debounce ----
    let _syncTimer = null;
    let _isSyncing = false;

    // ---- Avatar colors ----
    const avatarColors = [
        '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
        '#3498db', '#9b59b6', '#e84393', '#00cec9', '#6c5ce7',
        '#fd79a8', '#ffeaa7', '#55efc4', '#74b9ff', '#a29bfe',
    ];

    // ---- Timeline Config ----
    const DAY_MINUTES = 24 * 60;
    const TIMELINE_START = 21 * 60;          // 21:00 in minutes
    const TIMELINE_END_DEFAULT = 24 * 60;    // 00:00 (next day)
    const BET_WINDOW_START = 21 * 60;        // 21:00
    // Fenêtre resserrée : la saison passée, la médiane des paris était à
    // 21:09 et personne n'a jamais parié après 21:44. Le dernier quart
    // d'heure ne servait qu'à attendre que les autres se découvrent.
    // À changer ici ET dans le trigger check_bet_window côté base.
    const BET_WINDOW_END = 21 * 60 + 30;     // 21:30

    // ---- Barème ----
    // Le coefficient ne multiplie que la victoire de base : jamais le tout
    // pile, jamais le feu sacré. Sinon un tout pile en finale (2 × 3 = 6)
    // vaudrait plus que la saison entière d'un très bon joueur.
    const POINTS_TOUT_PILE = 1;              // bonus fixe
    const COMBO_CAP = 2;                     // plafond du feu sacré

    function computePoints(isToutPile, multiplier, streak) {
        const base = 1 * Math.max(1, multiplier || 1);
        const toutPile = isToutPile ? POINTS_TOUT_PILE : 0;
        const combo = Math.min(streak || 0, COMBO_CAP);
        return { base, toutPile, combo, total: base + toutPile + combo };
    }

    // ---- Admin Check ----
    const urlParams = new URLSearchParams(window.location.search);
    const wantsAdmin = urlParams.get('admin') === 'true';
    let isAdmin = false; // becomes true after password verification

    // ---- DOM Elements ----
    const $ = (sel) => document.querySelector(sel);

    const liveClock = $('#liveClock');
    const clockStatus = $('#clockStatus');
    const betForm = $('#betForm');
    const playerName = $('#playerName');
    const betTime = $('#betTime');
    const formError = $('#formError');
    const playersList = $('#playersList');
    const emptyState = $('#emptyState');
    const playerCount = $('#playerCount');
    const timelineSection = $('#timelineSection');
    const timelineProgress = $('#timelineProgress');
    const timelineCurrent = $('#timelineCurrent');
    const timelineLabels = $('#timelineLabels');
    const timelineMarkers = $('#timelineMarkers');
    const finSection = $('#finSection');
    const btnFin = $('#btnFin');
    const betSection = $('#betSection');
    const resultSection = $('#resultSection');
    const resultTime = $('#resultTime');
    const resultWinner = $('#resultWinner');
    const resultDetails = $('#resultDetails');
    const btnReset = $('#btnReset');
    const confetti = $('#confetti');
    
    // Admin specific elements
    const adminBar = $('#adminBar');
    const episodeNumberInput = $('#episodeNumber');
    const btnEpisodeSave = $('#btnEpisodeSave');
    const btnNewEpisode = $('#btnNewEpisode');
    const episodeLabel = $('#episodeLabel');
    const leaderboardContainer = $('#leaderboardContainer');
    const multiplierInput = $('#episodeMultiplier');
    const btnMultiplierSave = $('#btnMultiplierSave');
    const multiplierBadge = $('#multiplierBadge');
    const timeField = $('#timeField');
    
    // Supabase config elements
    const betCodeInput = $('#betCode');
    const codeGroup = $('#codeGroup');
    const adminCodeSection = $('#adminCodeSection');
    const codeDisplay = $('#codeDisplay');

    const btnToggleConfig = $('#btnToggleConfig');
    const supabaseConfigDropdown = $('#supabaseConfigDropdown');
    const sbUrlInput = $('#sbUrl');
    const sbKeyInput = $('#sbKey');
    const btnSaveSbConfig = $('#btnSaveSbConfig');
    const btnDisconnectSb = $('#btnDisconnectSb');
    const sbConnectionStatus = $('#sbConnectionStatus');
    const migrationContainer = $('#migrationContainer');
    const btnMigrate = $('#btnMigrate');

    // ---- Utility Functions ----

    /**
     * Convertit une heure HH:MM en « minute de jeu ».
     *
     * La soirée déborde sur le lendemain : une annonce à 00:07 doit se situer
     * APRÈS un pari à 23:55, pas huit heures avant. On projette donc tout sur
     * un axe continu où 00:00–11:59 appartient au lendemain (+24 h).
     * Sans ça, une annonce après minuit désigne le pari le plus précoce
     * comme vainqueur et n'invalide personne.
     */
    function timeToMinutes(timeStr) {
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + m + (h < 12 ? DAY_MINUTES : 0);
    }

    function minutesToTime(minutes) {
        const h = Math.floor(minutes / 60) % 24;
        const m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function minutesToHHMMSS(minutes) {
        const h = Math.floor(minutes / 60) % 24;
        const m = minutes % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function showError(msg) {
        formError.textContent = msg;
        setTimeout(() => { formError.textContent = ''; }, 4000);
    }

    function removeBet(id) {
        state.bets = state.bets.filter(b => b.id !== id);
        saveActiveGameLocally();
        markRenderDirty();
        renderPlayers();
        renderTimeline();
        showSections();
    }

    function getTimelineEnd() {
        let end = TIMELINE_END_DEFAULT;
        state.bets.forEach(b => {
            if (b.minutes + 15 > end) end = b.minutes + 15;
        });
        return end;
    }

    function getTimelinePercent(minutes) {
        const timelineEnd = getTimelineEnd();
        const range = timelineEnd - TIMELINE_START;
        if (range <= 0) return 0;
        const pct = ((minutes - TIMELINE_START) / range) * 100;
        return Math.max(0, Math.min(100, pct));
    }

    /** Mark that a full re-render of players/timeline is needed */
    function markRenderDirty() {
        _renderDirty = true;
    }

    /** Couleur stable, dérivée du nom : elle ne bouge plus d'une sync à l'autre. */
    function colorForName(name) {
        const key = String(name).trim().toLowerCase();
        let hash = 0;
        for (let i = 0; i < key.length; i++) {
            hash = (hash * 31 + key.charCodeAt(i)) % 100000;
        }
        return avatarColors[hash % avatarColors.length];
    }

    function multiplierLabel(mult) {
        if (mult === 3) return 'FINALE ×3';
        if (mult === 2) return 'ORIENTATION ×2';
        if (mult > 1) return `×${mult}`;
        return '';
    }

    function renderEpisodeLabel() {
        const badge = multiplierLabel(state.multiplier);
        episodeLabel.textContent = `${SEASON_LABEL} — ÉPISODE ${state.episodeNumber}`;
        if (episodeNumberInput) episodeNumberInput.value = state.episodeNumber;
        if (multiplierInput) multiplierInput.value = state.multiplier;
        if (multiplierBadge) {
            multiplierBadge.textContent = badge ? `🔥 ${badge} — POINTS MULTIPLIÉS` : '';
            multiplierBadge.style.display = badge ? 'block' : 'none';
        }
    }

    // ---- Shared Winner Computation (single source of truth) ----
    /**
     * Computes the winner from a list of bets and an end time.
     * @param {Array} bets - Array of bet objects with { name, minutes, ... }
     * @param {number} endMinutes - The end time in minutes since 00:00
     * @returns {{ winner: object|null, points: number, allInvalidated: boolean }}
     */
    function computeWinner(bets, endMinutes) {
        const validBets = bets.filter(b => b.minutes >= endMinutes);
        const invalidBets = bets.filter(b => b.minutes < endMinutes);

        let winner = null;
        let points = 1;
        let allInvalidated = false;

        if (validBets.length > 0) {
            validBets.sort((a, b) => (a.minutes - endMinutes) - (b.minutes - endMinutes));
            winner = validBets[0];
            if (winner.minutes === endMinutes) points = 2; // Tout pile!
        } else {
            allInvalidated = true;
            invalidBets.sort((a, b) => b.minutes - a.minutes);
            winner = invalidBets[0] || null;
        }

        return { winner, points, allInvalidated };
    }

    // ---- LocalStorage Helpers (Local Game Mode / Fallback) ----
    function saveActiveGameLocally() {
        if (state.isSupabaseConnected) return; // DB handles it
        localStorage.setItem('jdh_active_game', JSON.stringify({
            bets: state.bets,
            gameEnded: state.gameEnded,
            endTime: state.endTime,
            endTimeStr: state.endTimeStr,
            episodeNumber: state.episodeNumber,
            multiplier: state.multiplier
        }));
    }

    function loadActiveGameLocally() {
        let hasActiveGame = false;
        const saved = localStorage.getItem('jdh_active_game');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                state.bets = data.bets || [];
                state.gameEnded = data.gameEnded || false;
                state.endTime = data.endTime || null;
                state.endTimeStr = data.endTimeStr || null;
                state.episodeNumber = data.episodeNumber || 1;
                state.multiplier = data.multiplier || 1;
                if (state.bets.length > 0) {
                    hasActiveGame = true;
                }
            } catch (e) {
                console.error("Erreur de chargement de la partie locale", e);
            }
        }

        // If no bets were loaded from the new key, check if legacy keys exist and migrate them!
        if (!hasActiveGame) {
            const legacyBets = localStorage.getItem('bets');
            if (legacyBets) {
                try {
                    const parsedLegacy = JSON.parse(legacyBets);
                    if (parsedLegacy && parsedLegacy.length > 0) {
                        state.bets = parsedLegacy;
                        
                        const legacyEnded = localStorage.getItem('gameEnded');
                        state.gameEnded = legacyEnded ? JSON.parse(legacyEnded) : false;
                        
                        const legacyEndTime = localStorage.getItem('endTime');
                        state.endTime = legacyEndTime ? JSON.parse(legacyEndTime) : null;
                        
                        const legacyEndTimeStr = localStorage.getItem('endTimeStr');
                        state.endTimeStr = legacyEndTimeStr ? JSON.parse(legacyEndTimeStr) : null;
                        
                        state.episodeNumber = 1; // default legacy episode number
                        
                        saveActiveGameLocally();
                        console.log("Migration des anciennes données de jeu locale ('bets', etc.) réussie !");
                    }
                } catch(e) {
                    console.error("Erreur lors de la migration des données legacy", e);
                }
            }
        }
    }

    function getLocalLeaderboard() {
        const saved = localStorage.getItem('jdh_leaderboard');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                console.error("Erreur du classement local", e);
            }
        }
        return {};
    }

    function saveLocalLeaderboard(leaderboard) {
        localStorage.setItem('jdh_leaderboard', JSON.stringify(leaderboard));
    }

    // ---- Supabase Initializer ----
    async function initSupabase() {
        // Guard: check if Supabase CDN loaded
        if (!window.supabase) {
            console.warn("Supabase JS SDK non chargé (CDN indisponible ?). Mode local activé.");
            setDisconnectedStatus();
            return;
        }

        const url = localStorage.getItem('jdh_sb_url') || DEFAULT_SUPABASE_URL;
        const key = localStorage.getItem('jdh_sb_key') || DEFAULT_SUPABASE_KEY;
        const usingDefaults = !localStorage.getItem('jdh_sb_url');

        if (url && key && key !== '__SUPABASE_ANON_KEY__') {
            try {
                supabase = window.supabase.createClient(url, key);
                
                // Test connection & get server time offset
                const serverTime = await fetchServerTime();
                if (serverTime) {
                    state.isSupabaseConnected = true;
                    sbConnectionStatus.textContent = usingDefaults ? "En ligne" : "Supabase";
                    sbConnectionStatus.className = "connection-status connected";
                    sbUrlInput.value = url;
                    sbKeyInput.value = key;
                    
                    // Setup real-time listeners
                    setupRealTimeSubscriptions();
                    
                    // Pull data
                    await doSyncWithSupabase();
                    
                    // Check if local storage migration is needed
                    checkMigrationNeeded();
                } else {
                    throw new Error("Could not fetch server time");
                }
            } catch (e) {
                console.error("Échec de connexion Supabase, repli local", e);
                setDisconnectedStatus();
            }
        } else {
            setDisconnectedStatus();
        }
    }

    function setDisconnectedStatus() {
        state.isSupabaseConnected = false;
        supabase = null;
        sbConnectionStatus.textContent = "Local Storage";
        sbConnectionStatus.className = "connection-status disconnected";
        loadActiveGameLocally();
    }

    // Toggle configuration panel
    btnToggleConfig.addEventListener('click', () => {
        const isHidden = supabaseConfigDropdown.style.display === 'none';
        supabaseConfigDropdown.style.display = isHidden ? 'flex' : 'none';
    });

    // Save Supabase Configuration
    btnSaveSbConfig.addEventListener('click', async () => {
        const url = sbUrlInput.value.trim();
        const key = sbKeyInput.value.trim();

        if (!url || !key) {
            alert("Veuillez remplir l'URL et la clé Anon.");
            return;
        }

        localStorage.setItem('jdh_sb_url', url);
        localStorage.setItem('jdh_sb_key', key);
        supabaseConfigDropdown.style.display = 'none';

        await initSupabase();
        
        // Refresh rendering
        markRenderDirty();
        renderPlayers();
        renderTimeline();
        showSections();
        renderLeaderboard();
    });

    if (btnDisconnectSb) {
        btnDisconnectSb.addEventListener('click', () => {
            localStorage.removeItem('jdh_sb_url');
            localStorage.removeItem('jdh_sb_key');
            sbUrlInput.value = '';
            sbKeyInput.value = '';
            supabaseConfigDropdown.style.display = 'none';
            setDisconnectedStatus();
            
            // Refresh rendering
            markRenderDirty();
            renderPlayers();
            renderTimeline();
            showSections();
            renderLeaderboard();
            alert("Déconnecté de Supabase ! Retour au mode Local Storage.");
        });
    }

    // ---- Reliable Server Time Synchronization ----
    async function fetchServerTime() {
        if (!supabase) return new Date();
        try {
            // Call pg function get_server_time()
            const { data, error } = await supabase.rpc('get_server_time');
            if (error) throw error;
            
            if (data && data[0]) {
                const serverTimeStr = data[0].server_time;
                const dbTime = new Date(serverTimeStr);
                const localTime = new Date();
                // Offset in ms (positive if server is ahead of client)
                state.dbTimeOffset = dbTime.getTime() - localTime.getTime();
                return dbTime;
            }
        } catch (e) {
            console.error("Impossible de récupérer l'heure du serveur Supabase", e);
        }
        return null;
    }

    // L'heure du jeu est celle de Paris, jamais celle de l'appareil.
    // getHours() lit le fuseau du telephone : un joueur en vacances au
    // Portugal voyait 20h10 quand il etait 21h10 ici, et se faisait refuser
    // ses paris toute la soiree, dans les deux sens, par un message faux.
    // L'ecart d'horloge, lui, reste corrige par state.dbTimeOffset.
    const PARIS_CLOCK = new Intl.DateTimeFormat('fr-FR', {
        timeZone: 'Europe/Paris', hourCycle: 'h23',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    /** Décrit un instant sur le même axe continu que timeToMinutes(). */
    function describeTime(d) {
        const parts = {};
        for (const part of PARIS_CLOCK.formatToParts(d)) parts[part.type] = part.value;
        const h = Number(parts.hour) % 24,
              m = Number(parts.minute),
              s = Number(parts.second);
        const pad = (n) => String(n).padStart(2, '0');
        return {
            hours: h,
            minutes: m,
            seconds: s,
            totalMinutes: h * 60 + m + (h < 12 ? DAY_MINUTES : 0),
            // Heure murale non decalee : sert aux controles de la fenetre de
            // pari, pour que le message reste juste a 10h du matin aussi.
            clockMinutes: h * 60 + m,
            formatted: `${pad(h)}:${pad(m)}:${pad(s)}`,
            formattedShort: `${pad(h)}:${pad(m)}`,
        };
    }

    function getReliableTime() {
        const localTime = new Date();
        if (state.isSupabaseConnected) {
            // Apply offset to match server time
            return describeTime(new Date(localTime.getTime() + state.dbTimeOffset));
        }
        return describeTime(localTime);
    }

    // ---- Real-time listeners ----
    let _channel = null;
    let _fallbackPoll = null;

    /**
     * Le websocket temps reel meurt quand le telephone se met en veille.
     * Sans reprise, la liste reste figee et le resultat n'arrive jamais :
     * on surveille donc l'etat de l'abonnement, on resynchronise au reveil
     * de l'onglet, et un rafraichissement de secours tourne en fond.
     */
    function setupRealTimeSubscriptions() {
        if (!supabase) return;

        if (_channel) {
            try { supabase.removeChannel(_channel); } catch (e) { /* deja ferme */ }
            _channel = null;
        }

        _channel = supabase.channel('public:room')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'episodes' }, () => {
                syncWithSupabase();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'predictions' }, () => {
                syncWithSupabase();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, () => {
                syncWithSupabase();
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    // On a pu manquer des evenements pendant la coupure
                    syncWithSupabase();
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    console.warn('Temps reel interrompu (' + status + '), reconnexion dans 5 s');
                    setTimeout(() => {
                        if (state.isSupabaseConnected) setupRealTimeSubscriptions();
                    }, 5000);
                }
            });

        if (!_fallbackPoll) {
            // Filet de securite : meme websocket mort, l'ecran finit par etre juste.
            _fallbackPoll = setInterval(() => {
                if (state.isSupabaseConnected && document.visibilityState === 'visible') {
                    syncWithSupabase();
                }
            }, 30000);
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.isSupabaseConnected) {
            fetchServerTime();
            syncWithSupabase();
        }
    });

    // ---- Debounced Sync Wrapper ----
    function syncWithSupabase() {
        // Debounce: if a sync is already scheduled, skip
        if (_syncTimer) clearTimeout(_syncTimer);
        _syncTimer = setTimeout(() => {
            _syncTimer = null;
            doSyncWithSupabase();
        }, 200);
    }

    // ---- Sync Data from Supabase (actual implementation) ----
    async function doSyncWithSupabase() {
        if (!state.isSupabaseConnected || !supabase) return;
        if (_isSyncing) return; // Prevent concurrent syncs
        _isSyncing = true;

        try {
            // 1. Fetch active episode (status = 'active')
            // If none, get the latest overall completed episode to render the result of the last game
            // Filtré sur la saison en cours : les épisodes des saisons
            // précédentes ne doivent jamais redevenir l'épisode courant.
            let { data: activeEpisodes, error: epError } = await supabase
                .from('episodes')
                .select('*')
                .eq('season', CURRENT_SEASON)
                .order('number', { ascending: false });

            if (epError) throw epError;

            let currentEpisode = activeEpisodes.find(ep => ep.status === 'active');

            // If no active, take the latest completed one (to show past results)
            if (!currentEpisode && activeEpisodes.length > 0) {
                currentEpisode = activeEpisodes[0];
            }

            if (currentEpisode) {
                state.episodeId = currentEpisode.id;
                state.episodeNumber = currentEpisode.number;
                state.season = currentEpisode.season;
                state.multiplier = currentEpisode.multiplier || 1;
                state.gameEnded = currentEpisode.status === 'completed';
                state.betCode = currentEpisode.status === 'active' ? (currentEpisode.bet_code || null) : null;
                
                // Parse announced time
                if (currentEpisode.announced_at) {
                    const dbAnnouncedDate = new Date(currentEpisode.announced_at);
                    // Standard announced time format (Europe/Paris timezone correction)
                    const parisHours = dbAnnouncedDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
                    state.endTimeStr = parisHours;
                    state.endTime = timeToMinutes(parisHours);
                } else {
                    state.endTime = null;
                    state.endTimeStr = null;
                }

                renderEpisodeLabel();

                // 2. Fetch predictions for this episode
                // predictions_visible : même contenu que la table, mais le nom
                // du joueur et la saison sont déjà joints.
                let { data: preds, error: predError } = await supabase
                    .from('predictions_visible')
                    .select('*')
                    .eq('episode_id', state.episodeId);

                if (predError) throw predError;

                state.bets = preds.map((p) => {
                    const formattedTime = p.predicted_time.substring(0, 5);
                    return {
                        id: p.id,
                        name: p.player_name,
                        time: formattedTime,
                        minutes: timeToMinutes(formattedTime),
                        // Couleur dérivée du nom : elle suit le joueur toute la
                        // saison au lieu de changer à chaque synchronisation.
                        color: colorForName(p.player_name),
                        isWinner: p.is_winner,
                        isToutPile: p.is_tout_pile,
                        comboBonus: p.combo_bonus || 0,
                        pointsWon: p.points_won
                    };
                });

                state.bets.sort((a, b) => a.minutes - b.minutes);
            } else {
                // No episodes at all
                state.episodeId = null;
                state.bets = [];
                state.gameEnded = false;
                state.endTime = null;
                state.endTimeStr = null;
                state.betCode = null;
                state.multiplier = 1;
                episodeLabel.textContent = `${SEASON_LABEL} — AUCUN ÉPISODE`;
            }

            // Populate player name autocomplete
            const { data: allPlayers } = await supabase.from('players').select('name').order('name');
            if (allPlayers) populatePlayerSuggestions(allPlayers.map(p => p.name));

            markRenderDirty();
            renderPlayers();
            renderTimeline();
            showSections();
            updateCodeUI();
            syncResultView();
            renderLeaderboard();
        } catch (e) {
            console.error("Erreur de synchronisation Supabase", e);
        } finally {
            _isSyncing = false;
        }
    }

    // ---- Check & Handle Migration ----
    function checkMigrationNeeded() {
        if (!state.isSupabaseConnected) return;
        
        const localSaved = localStorage.getItem('jdh_active_game');
        if (localSaved) {
            try {
                const localData = JSON.parse(localSaved);
                if (localData.bets && localData.bets.length > 0) {
                    // Show migration container if admin is active
                    if (isAdmin) {
                        migrationContainer.style.display = 'block';
                    }
                }
            } catch(e) {}
        }
    }

    btnMigrate.addEventListener('click', async () => {
        if (!state.isSupabaseConnected || !supabase) return;

        const localSaved = localStorage.getItem('jdh_active_game');
        if (!localSaved) return;

        try {
            const localData = JSON.parse(localSaved);
            const bets = localData.bets || [];
            const localEpNumber = localData.episodeNumber || 1;

            if (!confirm(`Voulez-vous téléverser tous les paris de votre session locale en cours (${bets.length} joueurs) vers Supabase ?`)) {
                return;
            }

            let currentEpisodeId = state.episodeId;

            // If there's no active episode on Supabase, create/activate one automatically
            if (!currentEpisodeId) {
                let { data: epId, error: rpcError } = await supabase.rpc('admin_activate_episode', {
                    p_pw: adminPw(), p_season: CURRENT_SEASON, p_number: localEpNumber
                });
                if (rpcError) throw rpcError;
                currentEpisodeId = epId;
            }

            for (const bet of bets) {
                // 1. Try to find or insert player
                let { data: player, error: pErr } = await supabase
                    .from('players')
                    .select('id')
                    .eq('name', bet.name)
                    .maybeSingle();

                if (pErr) throw pErr;

                let playerId;
                if (!player) {
                    let { data: newP, error: insertPErr } = await supabase
                        .from('players')
                        .insert({ name: bet.name })
                        .select('id')
                        .single();

                    if (insertPErr) throw insertPErr;
                    playerId = newP.id;
                } else {
                    playerId = player.id;
                }

                // 2. Insert prediction (ignore duplicates)
                await supabase
                    .from('predictions')
                    .insert({
                        episode_id: currentEpisodeId,
                        player_id: playerId,
                        predicted_time: bet.time + ":00"
                    });
            }

            // Clear local storage active game state
            localStorage.removeItem('jdh_active_game');
            migrationContainer.style.display = 'none';
            alert("Importation réussie ! Vos données locales sont désormais en ligne.");
            
            await doSyncWithSupabase();
        } catch (e) {
            console.error("Erreur de migration", e);
            alert("Erreur lors de la migration. Voir la console pour plus de détails.");
        }
    });

    // ---- Player autocomplete ----
    function populatePlayerSuggestions(names) {
        const dl = document.getElementById('playerSuggestions');
        if (!dl) return;
        dl.innerHTML = names.map(n => `<option value="${escapeAttr(n)}">`).join('');
    }

    // ---- Code UI (show/hide field + admin display) ----
    function updateCodeUI() {
        const needCode = state.isSupabaseConnected && state.betCode && !state.gameEnded;
        if (codeGroup) codeGroup.style.display = needCode ? 'block' : 'none';
        if (adminCodeSection) adminCodeSection.style.display = (isAdmin && state.isSupabaseConnected && !state.gameEnded) ? 'flex' : 'none';
        if (codeDisplay) codeDisplay.textContent = state.betCode || '— (aucun)';
    }

    function resetBetForm() {
        playerName.value = '';
        betTime.value = '';
        updateTimePlaceholder();
        if (betCodeInput) betCodeInput.value = '';
        formError.textContent = '';
        const btnAdd = $('#btnAdd');
        if (btnAdd) {
            btnAdd.innerHTML = `<span class="btn-icon">➕</span> Ajouter le pari`;
            btnAdd.classList.remove('editing');
        }
    }

    /**
     * Android n'affiche rien du tout dans un <input type="time"> vide :
     * pas de « --:-- », pas d'icône. Le champ ressemble à une case morte.
     * On affiche donc notre propre substitut tant qu'aucune heure n'est
     * choisie, masqué dès qu'il y en a une.
     */
    function updateTimePlaceholder() {
        if (!timeField) return;
        timeField.classList.toggle('is-empty', !betTime.value);
    }

    betTime.addEventListener('input', updateTimePlaceholder);
    betTime.addEventListener('change', updateTimePlaceholder);

    // ---- Clock UI Updater ----
    function updateClock() {
        const now = getReliableTime();
        liveClock.textContent = now.formatted;

        // Le seul temoin de connexion vit dans la barre admin, invisible pour
        // un joueur. Sans ce message, une coupure au chargement le laisse
        // parier dans le vide : son pari s'affiche « En jeu » et ne part
        // jamais. Il n'y a pas de reprise automatique, d'ou « recharge ».
        if (!state.isSupabaseConnected) {
            clockStatus.textContent = 'HORS LIGNE — ton pari ne part pas. Recharge la page.';
            clockStatus.className = 'clock-status offline';
            return;
        }

        if (state.gameEnded) {
            clockStatus.textContent = 'Partie terminée';
            clockStatus.className = 'clock-status';
        } else if (state.bets.length === 0) {
            clockStatus.textContent = 'En attente des pronostics…';
            clockStatus.className = 'clock-status';
        } else {
            clockStatus.textContent = 'Partie en cours — en direct';
            clockStatus.className = 'clock-status live';
        }
    }

    // ---- Add Bet Logic ----
    async function handleAddBet(name, time) {
        const reliableTime = getReliableTime();

        // 22:00 Bet Window limit check
        if (reliableTime.clockMinutes >= BET_WINDOW_END) {
            showError("Les paris se sont arrêtés à 21h30 !");
            return;
        }

        // 21:00 Bet Window start check
        if (reliableTime.clockMinutes < BET_WINDOW_START) {
            showError("Les pronostics n'ouvrent qu'à 21h00 !");
            return;
        }

        // Code check
        if (state.isSupabaseConnected && state.betCode) {
            const entered = betCodeInput ? betCodeInput.value.trim() : '';
            if (entered !== state.betCode) {
                showError('Code de partie incorrect !');
                if (betCodeInput) betCodeInput.value = '';
                return;
            }
        }

        if (state.isSupabaseConnected && supabase) {
            if (!state.episodeId) {
                showError("Aucun épisode actif. Demandez à l'administrateur de lancer l'épisode.");
                return;
            }

            try {
                // Check if player already has a bet for this episode
                const existingBet = state.bets.find(b => b.name.toLowerCase() === name.toLowerCase());

                if (existingBet) {
                    // Update prediction time
                    const { error: updateErr } = await supabase
                        .from('predictions')
                        .update({ predicted_time: time + ":00" })
                        .eq('id', existingBet.id);

                    if (updateErr) {
                        if (updateErr.code === '23505') { // Unique constraint violation (time already taken)
                            showError(`L'heure ${time} est déjà prise ! Choisissez-en une autre.`);
                        } else {
                            throw updateErr;
                        }
                        return;
                    }
                    await doSyncWithSupabase();
                } else {
                    // 1. Insert player or fetch existing
                    let { data: player, error: pErr } = await supabase
                        .from('players')
                        .select('id')
                        .eq('name', name)
                        .maybeSingle();

                    if (pErr) throw pErr;

                    let playerId;
                    if (!player) {
                        let { data: newP, error: insertPErr } = await supabase
                            .from('players')
                            .insert({ name })
                            .select('id')
                            .single();

                        if (insertPErr) throw insertPErr;
                        playerId = newP.id;
                    } else {
                        playerId = player.id;
                    }

                    // 2. Insert prediction
                    const { error: predErr } = await supabase
                        .from('predictions')
                        .insert({
                            episode_id: state.episodeId,
                            player_id: playerId,
                            predicted_time: time + ":00"
                        });

                    if (predErr) {
                        if (predErr.code === '23505') { // Unique constraint violation
                            if (predErr.message.includes('unique_time_per_episode')) {
                                showError(`L'heure ${time} est déjà prise ! Choisissez-en une autre.`);
                            } else {
                                showError(`${name} a déjà un pronostic enregistré.`);
                            }
                        } else {
                            throw predErr;
                        }
                        return;
                    }
                    await doSyncWithSupabase();
                }
            } catch (e) {
                console.error("Erreur d'ajout ou modification de pronostic", e);
                // Le serveur dit deja pourquoi il refuse : le cacher derriere
                // « erreur serveur » fait croire a un incident reseau, et le
                // joueur s'acharne au lieu de comprendre que c'est ferme.
                const msg = (e && e.message) || '';
                showError(/paris ne sont autoris|pisode n'est pas actif/i.test(msg)
                    ? msg
                    : "Erreur serveur lors de la soumission.");
                // On sort avant resetBetForm() : sur un echec, l'heure saisie
                // doit rester dans le champ, comme dans le cas du doublon.
                return;
            }
        } else {
            // Local fallback Mode
            const minutes = timeToMinutes(time);
            const existingLocalBet = state.bets.find(b => b.name.toLowerCase() === name.toLowerCase());

            if (existingLocalBet) {
                // Check if this time is already taken by another player locally
                if (state.bets.some(b => b.name.toLowerCase() !== name.toLowerCase() && b.minutes === minutes)) {
                    showError(`L'heure ${time} est déjà prise ! Choisissez-en une autre.`);
                    return;
                }
                
                existingLocalBet.time = time;
                existingLocalBet.minutes = minutes;
                
                state.bets.sort((a, b) => a.minutes - b.minutes);
                saveActiveGameLocally();
                markRenderDirty();
                renderPlayers();
                renderTimeline();
                showSections();
            } else {
                // Check if this time is already taken locally
                if (state.bets.some(b => b.minutes === minutes)) {
                    showError(`L'heure ${time} est déjà prise ! Choisissez-en une autre.`);
                    return;
                }

                const id = Date.now() + Math.random();

                state.bets.push({
                    id,
                    name: name.trim(),
                    time,
                    minutes,
                    color: colorForName(name),
                });

                state.bets.sort((a, b) => a.minutes - b.minutes);
                saveActiveGameLocally();
                markRenderDirty();
                renderPlayers();
                renderTimeline();
                showSections();
            }
        }

        resetBetForm();
        playerName.focus();
    }

    betForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (state.gameEnded) return;

        const name = playerName.value.trim();
        const time = betTime.value;

        if (!name) { showError('Entrez le nom du joueur.'); return; }
        if (!time) { showError('Choisissez une heure.'); return; }

        handleAddBet(name, time);
    });

    playerName.addEventListener('input', () => {
        const name = playerName.value.trim().toLowerCase();
        const exists = state.bets.some(b => b.name.toLowerCase() === name);
        const btnAdd = $('#btnAdd');
        if (btnAdd) {
            if (exists) {
                btnAdd.innerHTML = `<span class="btn-icon">✏️</span> Modifier le pari`;
                btnAdd.classList.add('editing');
            } else {
                btnAdd.innerHTML = `<span class="btn-icon">➕</span> Ajouter le pari`;
                btnAdd.classList.remove('editing');
            }
        }
    });

    // ---- Delete Bet Logic (event delegation — no more window._removeBet) ----
    async function handleDeleteBet(id) {
        if (!isAdmin) return;
        
        if (state.isSupabaseConnected && supabase) {
            try {
                const { error } = await supabase.rpc('admin_delete_prediction', {
                    p_pw: adminPw(), p_pred_id: id
                });
                if (error) throw error;
                await doSyncWithSupabase();
            } catch (e) {
                console.error("Erreur de suppression", e);
            }
        } else {
            // Local mode delete
            removeBet(id);
        }
    }

    // Event delegation on playersList for delete and edit buttons
    playersList.addEventListener('click', (e) => {
        const deleteBtn = e.target.closest('.btn-delete');
        if (deleteBtn && !state.gameEnded) {
            const id = deleteBtn.dataset.betId;
            if (id) handleDeleteBet(id);
            return;
        }

        const editBtn = e.target.closest('.btn-edit');
        if (editBtn && !state.gameEnded) {
            const pName = editBtn.dataset.playerName;
            const bTime = editBtn.dataset.betTime;
            
            if (pName && bTime) {
                playerName.value = pName;
                betTime.value = bTime;
                updateTimePlaceholder();
                
                // Scroll layout to bet form
                betSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                
                const btnAdd = $('#btnAdd');
                if (btnAdd) {
                    btnAdd.innerHTML = `<span class="btn-icon">✏️</span> Modifier le pari`;
                    btnAdd.classList.add('editing');
                }
                
                betTime.focus();
            }
        }
    });

    // ---- Render Players List ----
    function renderPlayers() {
        const now = getReliableTime();
        playerCount.textContent = `(${state.bets.length})`;

        if (state.bets.length === 0) {
            playersList.innerHTML = '';
            playersList.appendChild(emptyState);
            emptyState.style.display = 'block';
            return;
        }

        emptyState.style.display = 'none';

        // Check if invalidated set changed (optimization for tick())
        const currentInvalidatedSet = state.bets
            .filter(b => !state.gameEnded && b.minutes < now.totalMinutes)
            .map(b => b.id)
            .join(',');

        // Skip full re-render if nothing changed
        if (!_renderDirty && currentInvalidatedSet === _lastInvalidatedSet) {
            return;
        }
        _lastInvalidatedSet = currentInvalidatedSet;
        _renderDirty = false;
        
        let html = '';
        state.bets.forEach((bet) => {
            const isInvalidated = !state.gameEnded && bet.minutes < now.totalMinutes;
            const initial = bet.name.charAt(0).toUpperCase();
            const safeName = escapeHtml(bet.name);
            const safeTime = escapeHtml(bet.time);
            const safeColor = escapeAttr(bet.color);
            const safeId = escapeAttr(String(bet.id));

            html += `
                <div class="player-row ${isInvalidated ? 'invalidated' : ''}" data-id="${safeId}" role="listitem">
                    <div class="player-info">
                        <div class="player-avatar" style="background: ${safeColor}">${initial}</div>
                        <span class="player-name">${safeName}</span>
                    </div>
                    <div class="player-right">
                        <span class="player-time">${safeTime}</span>
                        ${!state.gameEnded ? `
                            <span class="player-status ${isInvalidated ? 'invalid' : 'valid'}">
                                ${isInvalidated ? '⏰ Dépassé' : '✓ En jeu'}
                            </span>
                            ${now.clockMinutes < BET_WINDOW_END && now.clockMinutes >= BET_WINDOW_START ? `
                                <button class="btn-edit" data-player-name="${escapeAttr(bet.name)}" data-bet-time="${safeTime}" title="Modifier le pronostic de ${safeName}" aria-label="Modifier ${safeName}">✏️</button>
                            ` : ''}
                            ${isAdmin ? `<button class="btn-delete" data-bet-id="${safeId}" title="Supprimer le pronostic de ${safeName}" aria-label="Supprimer ${safeName}">✕</button>` : ''}
                        ` : ''}
                    </div>
                </div>
            `;
        });

        playersList.innerHTML = html;
    }

    // ---- Sections Visibility ----
    function showSections() {
        const hasBets = state.bets.length > 0;
        timelineSection.style.display = hasBets ? 'block' : 'none';
        
        // Admin controls visibility
        finSection.style.display = (hasBets && !state.gameEnded && isAdmin) ? 'block' : 'none';
        betSection.style.display = state.gameEnded ? 'none' : 'block';
        btnReset.style.display = (state.gameEnded && isAdmin) ? 'inline-block' : 'none';
        updateCodeUI();

        // Only admin sees the New Episode and Episode form
        // Handled directly via display styles of adminBar in HTML init
    }

    // ---- Timeline Rendering ----
    function renderTimeline() {
        if (state.bets.length === 0) return;

        const now = getReliableTime();
        const timelineEnd = getTimelineEnd();

        // Labels
        const labelCount = 7;
        let labelsHtml = '';
        for (let i = 0; i <= labelCount; i++) {
            const min = TIMELINE_START + (i / labelCount) * (timelineEnd - TIMELINE_START);
            labelsHtml += `<span>${minutesToTime(Math.round(min))}</span>`;
        }
        timelineLabels.innerHTML = labelsHtml;

        // Progress bar
        const progressPct = getTimelinePercent(now.totalMinutes + now.seconds / 60);
        timelineProgress.style.width = progressPct + '%';
        timelineCurrent.style.left = progressPct + '%';

        // Markers
        let markersHtml = '';
        state.bets.forEach((bet, i) => {
            const pct = getTimelinePercent(bet.minutes);
            const isInvalidated = !state.gameEnded && bet.minutes < now.totalMinutes;
            const position = i % 2 === 0 ? 'top' : 'bottom';
            const safeName = escapeHtml(bet.name);
            const safeTime = escapeHtml(bet.time);

            markersHtml += `
                <div class="timeline-marker ${position}" style="left: ${pct}%">
                    ${position === 'top' ? `
                        <span class="marker-label">${safeName}</span>
                        <span class="marker-time">${safeTime}</span>
                        <div class="marker-line"></div>
                        <div class="marker-dot ${isInvalidated ? 'invalid' : 'valid'}"></div>
                    ` : `
                        <div class="marker-dot ${isInvalidated ? 'invalid' : 'valid'}"></div>
                        <div class="marker-line"></div>
                        <span class="marker-time">${safeTime}</span>
                        <span class="marker-label">${safeName}</span>
                    `}
                </div>
            `;
        });

        timelineMarkers.innerHTML = markersHtml;
    }

    // ---- FIN Button Click (Close Episode) ----
    btnFin.addEventListener('click', async () => {
        if (!isAdmin) return;
        if (state.gameEnded) return;
        if (state.bets.length === 0) return;

        if (!confirm("⚠️ Denis a annoncé l'épisode de la semaine prochaine ?\n\nCliquez sur OK pour valider l'heure de fin.")) {
            return;
        }

        const reliableTime = getReliableTime();

        if (state.isSupabaseConnected && supabase && state.episodeId) {
            // Un seul appel : le serveur horodate, désigne le vainqueur,
            // applique le barème et clôture — dans une seule transaction.
            // Une coupure réseau ne peut plus laisser l'épisode à moitié scoré,
            // et le calcul n'est plus dictable depuis le navigateur.
            btnFin.disabled = true;
            try {
                const { error } = await supabase.rpc('admin_close_episode', {
                    p_pw: adminPw(),
                    p_ep_id: state.episodeId,
                    p_announced: null   // null = l'horloge du serveur fait foi
                });

                if (error) throw error;

                await doSyncWithSupabase();
            } catch (e) {
                console.error("Erreur lors de la clôture de l'épisode", e);
                // Si la reponse s'est perdue alors que la transaction etait
                // passee, l'episode EST clos. Annoncer un echec pousse a
                // chercher « Nouvelle partie », qui detruit les pronostics.
                if (/d.j. cl.tur/i.test((e && e.message) || '')) {
                    await doSyncWithSupabase();
                    alert("L'épisode était déjà clôturé — le résultat est affiché.");
                } else {
                    reportAdminError(e, "La clôture a échoué. L'épisode est resté ouvert, vous pouvez réessayer.");
                }
            } finally {
                btnFin.disabled = false;
            }
        } else {
            // Local Mode
            state.gameEnded = true;
            state.endTime = reliableTime.totalMinutes;
            state.endTimeStr = reliableTime.formattedShort;

            // Apply points locally using shared function
            const { winner, allInvalidated } = computeWinner(state.bets, state.endTime);

            if (winner) {
                const leaderboard = getLocalLeaderboard();
                const wName = winner.name.trim();
                if (!leaderboard[wName]) {
                    leaderboard[wName] = { points: 0, wins: 0, toutpile: 0, totalGap: 0, gapCount: 0 };
                }

                // Feu sacré : victoires consécutives, plafonnées
                const lastWinner = localStorage.getItem('jdh_last_winner');
                const streak = (lastWinner === wName)
                    ? parseInt(localStorage.getItem('jdh_streak') || '0', 10)
                    : 0;
                const isToutPile = winner.minutes === state.endTime;
                const score = computePoints(isToutPile, state.multiplier, streak);

                leaderboard[wName].points += score.total;
                leaderboard[wName].wins += 1;
                if (isToutPile) leaderboard[wName].toutpile += 1;

                // Écart de tout le monde : permet une précision moyenne honnête
                state.bets.forEach(b => {
                    const n = b.name.trim();
                    if (!leaderboard[n]) {
                        leaderboard[n] = { points: 0, wins: 0, toutpile: 0, totalGap: 0, gapCount: 0 };
                    }
                    leaderboard[n].totalGap = (leaderboard[n].totalGap || 0) + Math.abs(b.minutes - state.endTime);
                    leaderboard[n].gapCount = (leaderboard[n].gapCount || 0) + 1;
                });

                saveLocalLeaderboard(leaderboard);
                localStorage.setItem('jdh_last_winner', wName);
                localStorage.setItem('jdh_streak', String(streak + 1));

                renderResultUI(winner, score, allInvalidated);
            } else {
                renderResultUI(null, null, allInvalidated);
            }

            renderLeaderboard();
            spawnConfetti();

            saveActiveGameLocally();
            showSections();
            updateClock();
        }
    });

    // Shared Result renderer
    function renderResultUI(winner, score, allInvalidated, opts) {
        const scroll = !opts || opts.scroll !== false;
        resultTime.textContent = state.endTimeStr;

        let winnerHtml = '';
        if (winner) {
            winnerHtml += `<div class="winner-name">🎉 ${escapeHtml(winner.name)} 🎉</div>`;

            const total = score ? score.total : 1;
            winnerHtml += `<div class="winner-points">+${total} point${total > 1 ? 's' : ''}</div>`;

            // Détail du barème : les joueurs doivent voir d'où viennent les points
            if (score) {
                const parts = [];
                const mult = multiplierLabel(state.multiplier);
                parts.push(mult ? `victoire ×${state.multiplier} (${score.base})` : `victoire (1)`);
                if (score.toutPile) parts.push(`💎 tout pile (+${score.toutPile})`);
                if (score.combo) parts.push(`🔥 feu sacré (+${score.combo})`);
                if (parts.length > 1) {
                    winnerHtml += `<div class="winner-breakdown">${escapeHtml(parts.join('  ·  '))}</div>`;
                }
            }

            if (allInvalidated) {
                winnerHtml += `<div class="all-invalidated-note">Toutes les heures dépassées — heure la plus tardive gagne</div>`;
            }
        }
        resultWinner.innerHTML = winnerHtml;

        // Details
        let detailsHtml = '';
        const allSorted = [...state.bets].sort((a, b) => a.minutes - b.minutes);
        allSorted.forEach(bet => {
            const isValid = bet.minutes >= state.endTime;
            const isWinner = winner && bet.name === winner.name;
            const diff = isValid ? (bet.minutes - state.endTime) : (state.endTime - bet.minutes);
            const diffLabel = diff === 0 ? 'pile !' : (isValid ? `+${diff} min` : `-${diff} min (dépassé)`);

            let statusClass = isWinner ? 'winner' : (isValid ? 'valid' : 'invalid');
            let statusLabel = isWinner ? '🏆 GAGNANT' : (isValid ? '✓ Valide' : '✗ Dépassé');

            detailsHtml += `
                <div class="detail-row">
                    <span class="detail-name">${escapeHtml(bet.name)}</span>
                    <span class="detail-time">${escapeHtml(bet.time)} (${escapeHtml(diffLabel)})</span>
                    <span class="detail-status ${statusClass}">${statusLabel}</span>
                </div>
            `;
        });
        resultDetails.innerHTML = detailsHtml;

        resultSection.style.display = 'block';
        finSection.style.display = 'none';

        if (scroll) {
            resultSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }

    // Quel épisode est actuellement affiché comme « terminé » ?
    // Évite de relancer les confettis et le défilement à chaque synchronisation.
    let _resultShownFor = null;

    /**
     * Affiche ou masque le résultat en fonction de l'état synchronisé.
     *
     * Appelée à CHAQUE synchronisation : c'est ce qui fait que les joueurs
     * voient le vainqueur au moment où l'admin appuie sur FIN, au lieu de
     * devoir recharger la page.
     */
    function syncResultView() {
        const ended = state.gameEnded && state.endTime !== null && state.bets.length > 0;

        if (!ended) {
            resultSection.style.display = 'none';
            _resultShownFor = null;
            return;
        }

        // Le serveur a déjà tranché : on affiche SON verdict, pas un recalcul.
        const dbWinner = state.bets.find(b => b.isWinner);
        const winner = dbWinner || computeWinner(state.bets, state.endTime).winner;
        const allInvalidated = state.bets.every(b => b.minutes < state.endTime);

        let score = null;
        if (dbWinner) {
            const toutPile = dbWinner.isToutPile ? POINTS_TOUT_PILE : 0;
            const combo = dbWinner.comboBonus || 0;
            score = {
                base: (dbWinner.pointsWon || 0) - toutPile - combo,
                toutPile,
                combo,
                total: dbWinner.pointsWon || 0
            };
        } else if (winner) {
            // Mode local : le feu sacré n'est pas rejouable après un rechargement
            score = computePoints(winner.minutes === state.endTime, state.multiplier, 0);
        }

        const isNew = _resultShownFor !== state.episodeId;
        renderResultUI(winner, score, allInvalidated, { scroll: isNew });

        if (isNew) {
            _resultShownFor = state.episodeId;
            spawnConfetti();
        }
    }

    // ---- Leaderboard Rendering (Supabase vs Local) ----
    // Portee du classement : la saison en cours, ou toutes saisons confondues.
    let _lbScope = 'season';

    async function renderLeaderboard() {
        let players = [];

        if (state.isSupabaseConnected && supabase) {
            try {
                // Jointure interne sur episodes pour pouvoir filtrer la saison :
                // sans ca le classement d'All Stars afficherait les points de
                // la saison precedente.
                let query = supabase
                    .from('predictions_visible')
                    .select('points_won, is_winner, is_tout_pile, combo_bonus, gap_minutes, player_name, season');

                if (_lbScope === 'season') {
                    query = query.eq('season', state.season);
                }

                const { data, error } = await query;
                if (error) throw error;

                // Group by player
                const totals = {};
                data.forEach(p => {
                    const name = p.player_name;
                    if (!totals[name]) {
                        totals[name] = { name, points: 0, wins: 0, toutpile: 0, combo: 0, totalGap: 0, gapCount: 0 };
                    }
                    totals[name].points += p.points_won;
                    if (p.is_winner) totals[name].wins += 1;
                    if (p.is_tout_pile) totals[name].toutpile += 1;
                    totals[name].combo += p.combo_bonus || 0;
                    // L'ecart est enregistre pour TOUS les parieurs : la precision
                    // moyenne devient une vraie statistique, et le departage
                    // separe enfin deux joueurs a zero victoire.
                    if (p.gap_minutes != null) {
                        totals[name].totalGap += p.gap_minutes;
                        totals[name].gapCount += 1;
                    }
                });

                players = Object.values(totals);
            } catch (e) {
                console.error("Erreur de calcul du classement en ligne", e);
            }
        } else {
            // Local leaderboard loading
            const localLb = getLocalLeaderboard();
            players = Object.keys(localLb).map(name => ({
                name,
                points: localLb[name].points || 0,
                wins: localLb[name].wins || 0,
                toutpile: localLb[name].toutpile || 0,
                combo: localLb[name].combo || 0,
                totalGap: localLb[name].totalGap || 0,
                gapCount: localLb[name].gapCount || 0
            }));
        }

        players.forEach(p => {
            p.avgGap = p.gapCount > 0 ? p.totalGap / p.gapCount : null;
        });

        // La bascule de portée s'affiche même sans données : c'est le seul
        // moyen d'aller voir l'historique des saisons précédentes.
        const scopeHtml = `
            <div class="lb-scope" role="group" aria-label="Portée du classement">
                <button class="lb-scope-btn ${_lbScope === 'season' ? 'active' : ''}" data-scope="season">${escapeHtml(SEASON_LABEL)}</button>
                <button class="lb-scope-btn ${_lbScope === 'all' ? 'active' : ''}" data-scope="all">Toutes saisons</button>
            </div>
        `;

        if (players.length === 0) {
            leaderboardContainer.innerHTML = `
                ${scopeHtml}
                <div class="empty-state">
                    <div class="empty-icon">📊</div>
                    <p>${_lbScope === 'season'
                        ? `Aucun point marqué sur ${escapeHtml(SEASON_LABEL)}.<br>Tout le monde est à égalité !`
                        : `Aucune partie jouée pour l'instant.`}</p>
                </div>
            `;
            return;
        }

        // Points → Victoires → Tout pile → Précision moyenne (plus proche = mieux)
        players.sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points;
            if (b.wins !== a.wins) return b.wins - a.wins;
            if (b.toutpile !== a.toutpile) return b.toutpile - a.toutpile;
            const aAvg = a.avgGap === null ? Infinity : a.avgGap;
            const bAvg = b.avgGap === null ? Infinity : b.avgGap;
            if (aAvg !== bAvg) return aAvg - bAvg;
            return a.name.localeCompare(b.name);
        });

        let html = `
            ${scopeHtml}
            <table class="leaderboard-table">
                <thead>
                    <tr>
                        <th>Rang</th>
                        <th>Joueur</th>
                        <th class="lb-col-center">Points</th>
                        <th class="lb-col-center"><span class="lb-full">Victoires</span><span class="lb-short" title="Victoires">🏆</span></th>
                        <th class="lb-col-center" title="Tout pile">💎</th>
                        <th class="lb-col-center" title="Bonus de feu sacré cumulé">🔥</th>
                        <th class="lb-col-center" title="Écart moyen entre le pari et l'heure réelle">Précision</th>
                    </tr>
                </thead>
                <tbody>
        `;

        players.forEach((p, idx) => {
            const rank = idx + 1;
            let rankClass = '';
            if (rank <= 3) rankClass = `rank-${rank}`;
            const precision = p.avgGap === null ? '—' : p.avgGap.toFixed(1);

            html += `
                <tr>
                    <td class="lb-rank ${rankClass}">${rank}</td>
                    <td class="lb-name">${escapeHtml(p.name)}</td>
                    <td class="lb-points lb-col-center">${p.points}</td>
                    <td class="lb-victories lb-col-center">${p.wins}</td>
                    <td class="lb-toutpile lb-col-center">${p.toutpile}</td>
                    <td class="lb-combo lb-col-center">${p.combo || '—'}</td>
                    <td class="lb-precision lb-col-center">${escapeHtml(precision)}<span class="lb-unit"> min</span></td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        if (isAdmin && _lbScope === 'season') {
            html += `<button class="btn-clear-lb" id="btnClearLb">Réinitialiser les points de ${escapeHtml(SEASON_LABEL)}</button>`;
        }

        leaderboardContainer.innerHTML = html;
    }

    // Event delegation for leaderboard clear button (avoids re-attaching listeners)
    leaderboardContainer.addEventListener('click', async (e) => {
        const scopeBtn = e.target.closest('.lb-scope-btn');
        if (scopeBtn) {
            const scope = scopeBtn.dataset.scope;
            if (scope && scope !== _lbScope) {
                _lbScope = scope;
                renderLeaderboard();
            }
            return;
        }

        const btn = e.target.closest('#btnClearLb');
        if (!btn || !isAdmin) return;

        if (confirm(`⚠️ Remettre à zéro tous les points de ${SEASON_LABEL} ?\n\nLes pronostics sont conservés, seuls les scores sont effacés. Les autres saisons ne sont pas touchées.`)) {
            if (state.isSupabaseConnected && supabase) {
                try {
                    // Reset scores on all predictions without deleting the history via RPC
                    const { error } = await supabase.rpc('admin_reset_leaderboard', {
                        p_pw: adminPw(), p_season: state.season
                    });
                    if (error) throw error;
                    await doSyncWithSupabase();
                } catch (e) {
                    console.error("Impossible de vider le classement", e);
                }
            } else {
                saveLocalLeaderboard({});
                renderLeaderboard();
            }
        }
    });

    // ---- Admin password verification ----
    // Le mot de passe est conservé pour la session : chaque fonction admin
    // le revérifie EN BASE. Sans lui, aucune écriture privilégiée n'est
    // possible, même en appelant les RPC à la main depuis la console.
    function adminPw() {
        return sessionStorage.getItem('jdh_admin_pw') || '';
    }

    async function verifyAdminAccess() {
        if (adminPw()) return true;
        const pw = prompt('Mot de passe administrateur :');
        if (!pw) return false;
        if (state.isSupabaseConnected && supabase) {
            try {
                const { data, error } = await supabase.rpc('verify_admin_password', { pw });
                if (error) throw error;
                if (data === true) {
                    sessionStorage.setItem('jdh_admin_pw', pw);
                    return true;
                }
                alert('Mot de passe incorrect.');
                return false;
            } catch (e) {
                console.error('Vérification admin impossible', e);
                alert('Erreur de vérification.');
                return false;
            }
        }
        // Hors ligne : la partie locale n'a pas d'enjeu partagé
        sessionStorage.setItem('jdh_admin_pw', pw);
        return true;
    }

    /** Signale un refus côté serveur de façon lisible. */
    function reportAdminError(e, fallback) {
        const msg = (e && (e.message || e.hint)) || '';
        if (/administrateur refusé/i.test(msg)) {
            sessionStorage.removeItem('jdh_admin_pw');
            alert('Mot de passe administrateur refusé. Rechargez la page pour ressaisir.');
        } else {
            alert(msg ? `${fallback}\n\n${msg}` : fallback);
        }
    }

    // ---- Admin Episode Actions ----
    // Track whether admin listeners have been attached (prevent duplicates)
    let _adminListenersAttached = false;

    function enableAdminUI() {
        adminBar.style.display = 'flex';

        // Guard: only attach listeners once
        if (_adminListenersAttached) return;
        _adminListenersAttached = true;
        
        // Save/Apply active episode number
        btnEpisodeSave.addEventListener('click', async () => {
            const val = parseInt(episodeNumberInput.value, 10);
            if (isNaN(val) || val <= 0) return;

            if (state.isSupabaseConnected && supabase) {
                try {
                    // Activate or create the episode using the admin RPC
                    let { error: rpcError } = await supabase.rpc('admin_activate_episode', {
                        p_pw: adminPw(), p_season: CURRENT_SEASON, p_number: val
                    });
                    if (rpcError) throw rpcError;
                    await doSyncWithSupabase();
                } catch (e) {
                    console.error("Erreur de mise à jour de l'épisode", e);
                }
            } else {
                state.episodeNumber = val;
                episodeLabel.textContent = `ÉPISODE ${val}`;
                saveActiveGameLocally();
            }
        });

        // Coefficient de l'episode : verrouille en base des qu'un pari existe,
        // pour qu'on ne puisse pas changer l'enjeu apres l'ouverture des paris.
        if (btnMultiplierSave) {
            btnMultiplierSave.addEventListener('click', async () => {
                const mult = parseInt(multiplierInput.value, 10);
                if (isNaN(mult) || mult < 1 || mult > 5) return;

                if (!state.isSupabaseConnected || !supabase || !state.episodeId) {
                    state.multiplier = mult;
                    renderEpisodeLabel();
                    saveActiveGameLocally();
                    return;
                }

                try {
                    const { error } = await supabase.rpc('admin_set_multiplier', {
                        p_pw: adminPw(), p_ep_id: state.episodeId, p_multiplier: mult
                    });
                    if (error) throw error;
                    await doSyncWithSupabase();
                    alert(mult > 1
                        ? `Coefficient x${mult} appliqu\u00e9 \u00e0 l'\u00e9pisode ${state.episodeNumber}.\nAnnonce-le dans le groupe AVANT 21h.`
                        : `\u00c9pisode ${state.episodeNumber} remis \u00e0 un coefficient normal.`);
                } catch (e) {
                    console.error('Impossible de r\u00e9gler le coefficient', e);
                    reportAdminError(e, 'Le coefficient n\u2019a pas pu \u00eatre modifi\u00e9.');
                }
            });
        }

        // Code generator button
        const btnGenCode = document.getElementById('btnGenCode');
        if (btnGenCode) {
            btnGenCode.addEventListener('click', async () => {
                const newCode = String(Math.floor(1000 + Math.random() * 9000));
                if (state.isSupabaseConnected && supabase && state.episodeId) {
                    const { error } = await supabase.rpc('admin_update_bet_code', {
                        p_pw: adminPw(), p_ep_id: state.episodeId, p_code: newCode
                    });
                    if (error) throw error;
                    await doSyncWithSupabase();
                    alert(`Nouveau code : ${newCode}\nEnvoie-le dans le groupe !`);
                }
            });
        }

        // Click on "+" to quickly launch next episode
        btnNewEpisode.addEventListener('click', async () => {
            const nextEp = state.episodeNumber + 1;
            if (state.isSupabaseConnected && supabase) {
                if (confirm(`Lancer l'épisode ${nextEp} ? Cela va clôturer l'épisode actuel.`)) {
                    try {
                        const newCode = String(Math.floor(1000 + Math.random() * 9000));
                        const { error } = await supabase.rpc('admin_create_episode', {
                            p_pw: adminPw(), p_season: CURRENT_SEASON, p_number: nextEp,
                            p_bet_code: newCode, p_multiplier: 1
                        });
                        if (error) throw error;
                        await doSyncWithSupabase();
                        alert(`Épisode ${nextEp} lancé !\nCode de partie : ${newCode}\nEnvoie-le dans le groupe !`);
                    } catch (e) {
                        console.error("Impossible de créer l'épisode", e);
                    }
                }
            } else {
                if (confirm(`Lancer l'épisode ${nextEp} localement ?`)) {
                    state.bets = [];
                    state.gameEnded = false;
                    state.endTime = null;
                    state.endTimeStr = null;
                    state.episodeNumber = nextEp;
                    state.multiplier = 1;
                    saveActiveGameLocally();
                    markRenderDirty();
                    renderPlayers();
                    renderTimeline();
                    showSections();
                    updateClock();
                    renderEpisodeLabel();
                }
            }
        });
    }

    // ---- Reset Current Episode (Admin) ----
    btnReset.addEventListener('click', async () => {
        if (!isAdmin) return;
        if (!confirm('Repartir à zéro ? Tous les pronostics de cette manche seront supprimés.')) return;

        if (state.isSupabaseConnected && supabase && state.episodeId) {
            try {
                // Delete all predictions of this episode via RPC
                const { error: predError } = await supabase.rpc('admin_delete_episode_predictions', {
                    p_pw: adminPw(), p_ep_id: state.episodeId
                });
                if (predError) throw predError;

                // Reopen episode via RPC
                const { error: epError } = await supabase.rpc('admin_reactivate_episode', {
                    p_pw: adminPw(), p_ep_id: state.episodeId
                });
                if (epError) throw epError;

                await doSyncWithSupabase();
            } catch (e) {
                console.error("Erreur de reset en ligne", e);
            }
        } else {
            // Local Reset
            state.bets = [];
            state.gameEnded = false;
            state.endTime = null;
            state.endTimeStr = null;

            saveActiveGameLocally();
            resultSection.style.display = 'none';
            markRenderDirty();
            renderPlayers();
            renderTimeline();
            showSections();
            updateClock();
        }
    });

    // ---- Particle details ----
    function spawnConfetti() {
        const colors = ['#ffd700', '#ff6b2b', '#e74c3c', '#2ecc71', '#3498db', '#9b59b6', '#ff8c42', '#00d4aa'];
        const count = 60;
        confetti.innerHTML = '';

        for (let i = 0; i < count; i++) {
            const piece = document.createElement('div');
            piece.classList.add('confetti-piece');
            piece.style.left = Math.random() * 100 + '%';
            piece.style.top = -10 + 'px';
            piece.style.background = colors[Math.floor(Math.random() * colors.length)];
            piece.style.animationDelay = (Math.random() * 1) + 's';
            piece.style.animationDuration = (Math.random() * 2 + 2) + 's';
            piece.style.width = (Math.random() * 8 + 4) + 'px';
            piece.style.height = (Math.random() * 8 + 4) + 'px';
            piece.style.transform = `rotate(${Math.random() * 360}deg)`;
            confetti.appendChild(piece);
        }
    }

    function initParticles() {
        const container = document.getElementById('particles');
        const count = 30;
        for (let i = 0; i < count; i++) {
            const p = document.createElement('div');
            p.classList.add('particle');
            p.style.left = Math.random() * 100 + '%';
            p.style.width = (Math.random() * 4 + 2) + 'px';
            p.style.height = p.style.width;
            p.style.animationDuration = (Math.random() * 8 + 6) + 's';
            p.style.animationDelay = (Math.random() * 10) + 's';
            container.appendChild(p);
        }
    }

    // ---- Optimized Tick Loop ----
    function tick() {
        updateClock();

        if (!state.gameEnded && state.bets.length > 0) {
            // Only update timeline progress bar position (lightweight)
            const now = getReliableTime();
            const progressPct = getTimelinePercent(now.totalMinutes + now.seconds / 60);
            timelineProgress.style.width = progressPct + '%';
            timelineCurrent.style.left = progressPct + '%';

            // Check if any bets have been newly invalidated — only then re-render
            const currentInvalidatedSet = state.bets
                .filter(b => b.minutes < now.totalMinutes)
                .map(b => b.id)
                .join(',');

            if (currentInvalidatedSet !== _lastInvalidatedSet) {
                renderPlayers();
                renderTimeline();
            }
        }
    }

    // ---- Init ----
    async function init() {
        initParticles();
        
        // 1. Initial configuration load
        loadActiveGameLocally();
        
        // 2. Setup dynamic view from localStorage
        renderEpisodeLabel();

        // 3. Connect to Supabase if configured
        await initSupabase();

        // 3b. Admin password gate
        if (wantsAdmin) {
            const ok = await verifyAdminAccess();
            if (ok) {
                isAdmin = true;
                enableAdminUI();
            }
        }

        // 4. Default render of available elements
        updateClock();
        markRenderDirty();
        renderPlayers();
        renderTimeline();
        showSections();
        renderLeaderboard();

        if (state.gameEnded && state.endTimeStr) {
            syncResultView();
        }

        // Start ticking every second
        setInterval(tick, 1000);
        // Sync server time every 5 minutes
        setInterval(fetchServerTime, 5 * 60 * 1000);
    }

    init();
})();
