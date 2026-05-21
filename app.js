/* ============================================
   LE JEU DES HEURES — APP LOGIC (WITH SUPABASE)
   ============================================ */

(() => {
    'use strict';

    // ---- Supabase backend (hardcoded for shared multi-player play) ----
    const DEFAULT_SUPABASE_URL = 'https://byippbemdlbhybcbuviv.supabase.co';
    const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aXBwYmVtZGxiaHliY2J1dml2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDgwNTYsImV4cCI6MjA4OTU4NDA1Nn0.HN2AkClZd15ZkJftwbWBk7qFhBlNWRs9l4IRMSP2VQ0';

    // ---- State ----
    const state = {
        bets: [],           // { id, name, time (HH:MM string), minutes (total min since 00:00), color }
        gameEnded: false,
        endTime: null,      // minutes since 00:00
        endTimeStr: null,
        episodeNumber: 12,  // Default episode number
        episodeId: null,    // Supabase episode UUID
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
    const TIMELINE_START = 21 * 60;          // 21:00 in minutes
    const TIMELINE_END_DEFAULT = 24 * 60;    // 00:00 (next day)
    const BET_WINDOW_START = 21 * 60;        // 21:00
    const BET_WINDOW_END = 22 * 60;          // 22:00

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

    function timeToMinutes(timeStr) {
        const [h, m] = timeStr.split(':').map(Number);
        return h * 60 + m;
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
            episodeNumber: state.episodeNumber
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
                state.episodeNumber = data.episodeNumber || 12;
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
                        
                        state.episodeNumber = 12; // default legacy episode number
                        
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

    function getReliableTime() {
        const localTime = new Date();
        if (state.isSupabaseConnected) {
            // Apply offset to match server time
            const serverMs = localTime.getTime() + state.dbTimeOffset;
            const sTime = new Date(serverMs);
            return {
                hours: sTime.getHours(),
                minutes: sTime.getMinutes(),
                seconds: sTime.getSeconds(),
                totalMinutes: sTime.getHours() * 60 + sTime.getMinutes(),
                formatted: `${String(sTime.getHours()).padStart(2, '0')}:${String(sTime.getMinutes()).padStart(2, '0')}:${String(sTime.getSeconds()).padStart(2, '0')}`,
                formattedShort: `${String(sTime.getHours()).padStart(2, '0')}:${String(sTime.getMinutes()).padStart(2, '0')}`,
            };
        } else {
            // Standard local time fallback
            return {
                hours: localTime.getHours(),
                minutes: localTime.getMinutes(),
                seconds: localTime.getSeconds(),
                totalMinutes: localTime.getHours() * 60 + localTime.getMinutes(),
                formatted: `${String(localTime.getHours()).padStart(2, '0')}:${String(localTime.getMinutes()).padStart(2, '0')}:${String(localTime.getSeconds()).padStart(2, '0')}`,
                formattedShort: `${String(localTime.getHours()).padStart(2, '0')}:${String(localTime.getMinutes()).padStart(2, '0')}`,
            };
        }
    }

    // ---- Real-time listeners ----
    function setupRealTimeSubscriptions() {
        if (!supabase) return;
        
        supabase.channel('public:room')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'episodes' }, () => {
                syncWithSupabase();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'predictions' }, () => {
                syncWithSupabase();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, () => {
                syncWithSupabase();
            })
            .subscribe();
    }

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
            let { data: activeEpisodes, error: epError } = await supabase
                .from('episodes')
                .select('*')
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

                episodeLabel.textContent = `ÉPISODE ${state.episodeNumber}`;
                episodeNumberInput.value = state.episodeNumber;

                // 2. Fetch predictions for this episode
                let { data: preds, error: predError } = await supabase
                    .from('predictions')
                    .select('*, players(name)')
                    .eq('episode_id', state.episodeId);

                if (predError) throw predError;

                state.bets = preds.map((p, idx) => {
                    const colorIdx = idx % avatarColors.length;
                    // Format time HH:MM from HH:MM:SS
                    const formattedTime = p.predicted_time.substring(0, 5);
                    return {
                        id: p.id,
                        name: p.players.name,
                        time: formattedTime,
                        minutes: timeToMinutes(formattedTime),
                        color: avatarColors[colorIdx],
                        isWinner: p.is_winner,
                        isToutPile: p.is_tout_pile,
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
                episodeLabel.textContent = `AUCUN ÉPISODE`;
            }

            // Populate player name autocomplete
            const { data: allPlayers } = await supabase.from('players').select('name').order('name');
            if (allPlayers) populatePlayerSuggestions(allPlayers.map(p => p.name));

            markRenderDirty();
            renderPlayers();
            renderTimeline();
            showSections();
            updateCodeUI();
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
            const localEpNumber = localData.episodeNumber || 12;

            if (!confirm(`Voulez-vous téléverser tous les paris de votre session locale en cours (${bets.length} joueurs) vers Supabase ?`)) {
                return;
            }

            let currentEpisodeId = state.episodeId;

            // If there's no active episode on Supabase, create/activate one automatically
            if (!currentEpisodeId) {
                let { data: epId, error: rpcError } = await supabase.rpc('admin_activate_episode', { ep_number: localEpNumber });
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

    // ---- Clock UI Updater ----
    function updateClock() {
        const now = getReliableTime();
        liveClock.textContent = now.formatted;

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
        if (reliableTime.totalMinutes >= BET_WINDOW_END) {
            showError("Les paris se sont arrêtés à 22h00 !");
            return;
        }

        // 21:00 Bet Window start check
        if (reliableTime.totalMinutes < BET_WINDOW_START) {
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
            } catch (e) {
                console.error("Erreur d'ajout de pronostic", e);
                showError("Erreur serveur lors de la soumission.");
            }
        } else {
            // Local fallback Mode
            const minutes = timeToMinutes(time);
            if (state.bets.some(b => b.minutes === minutes)) {
                showError(`L'heure ${time} est déjà prise ! Choisissez-en une autre.`);
                return;
            }

            if (state.bets.some(b => b.name.toLowerCase() === name.toLowerCase())) {
                showError(`${name} a déjà un pronostic enregistré.`);
                return;
            }

            const id = Date.now() + Math.random();
            const colorIdx = state.bets.length % avatarColors.length;

            state.bets.push({
                id,
                name: name.trim(),
                time,
                minutes,
                color: avatarColors[colorIdx],
            });

            state.bets.sort((a, b) => a.minutes - b.minutes);
            saveActiveGameLocally();
            markRenderDirty();
            renderPlayers();
            renderTimeline();
            showSections();
        }

        playerName.value = '';
        betTime.value = '';
        if (betCodeInput) betCodeInput.value = '';
        playerName.focus();
        formError.textContent = '';
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

    // ---- Delete Bet Logic (event delegation — no more window._removeBet) ----
    async function handleDeleteBet(id) {
        if (!isAdmin) return;
        
        if (state.isSupabaseConnected && supabase) {
            try {
                const { error } = await supabase.rpc('admin_delete_prediction', { pred_id: id });
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

    // Event delegation on playersList for delete buttons
    playersList.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-delete');
        if (!btn) return;
        if (state.gameEnded) return;
        const id = btn.dataset.betId;
        if (id) handleDeleteBet(id);
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
            .filter(b => !state.gameEnded && b.minutes <= now.totalMinutes)
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
            const isInvalidated = !state.gameEnded && bet.minutes <= now.totalMinutes;
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
            const isInvalidated = !state.gameEnded && bet.minutes <= now.totalMinutes;
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
            try {
                // Get precise timestamp from server
                const { data: serverTimeData } = await supabase.rpc('get_server_time');
                const serverTimeStr = serverTimeData[0].server_time;

                // Compute winner using shared function
                const endMin = reliableTime.totalMinutes;
                const { winner, points } = computeWinner(state.bets, endMin);

                // Save results of predictions to Supabase via RPC
                for (const bet of state.bets) {
                    const isWinner = winner && bet.name === winner.name;
                    const isToutPile = isWinner && points === 2;
                    const finalPoints = isWinner ? points : 0;
                    const gapMinutes = isWinner ? Math.abs(bet.minutes - endMin) : null;

                    const { error } = await supabase.rpc('admin_update_prediction_result', {
                        pred_id: bet.id,
                        p_points_won: finalPoints,
                        p_is_winner: isWinner,
                        p_is_tout_pile: isToutPile,
                        p_gap_minutes: gapMinutes
                    });

                    if (error) throw error;
                }

                // Mark episode as completed with real server timestamp via RPC
                const { error: epError } = await supabase.rpc('admin_close_episode', {
                    ep_id: state.episodeId,
                    announced_timestamp: serverTimeStr
                });

                if (epError) throw epError;

                await doSyncWithSupabase();
            } catch (e) {
                console.error("Erreur lors de la clôture de l'épisode", e);
                alert("Erreur réseau lors de la clôture.");
            }
        } else {
            // Local Mode
            state.gameEnded = true;
            state.endTime = reliableTime.totalMinutes;
            state.endTimeStr = reliableTime.formattedShort;

            // Apply points locally using shared function
            const { winner, points, allInvalidated } = computeWinner(state.bets, state.endTime);

            if (winner) {
                const leaderboard = getLocalLeaderboard();
                const wName = winner.name.trim();
                if (!leaderboard[wName]) {
                    leaderboard[wName] = { points: 0, wins: 0, toutpile: 0, totalGap: 0 };
                }
                leaderboard[wName].points += points;
                leaderboard[wName].wins += 1;
                if (points === 2) leaderboard[wName].toutpile += 1;
                leaderboard[wName].totalGap = (leaderboard[wName].totalGap || 0) + Math.abs(winner.minutes - state.endTime);
                saveLocalLeaderboard(leaderboard);
            }

            renderResultUI(winner, points, allInvalidated);
            renderLeaderboard();
            spawnConfetti();

            saveActiveGameLocally();
            showSections();
            updateClock();
        }
    });

    // Shared Result renderer
    function renderResultUI(winner, points, allInvalidated) {
        resultTime.textContent = state.endTimeStr;

        let winnerHtml = '';
        if (winner) {
            winnerHtml += `<div class="winner-name">🎉 ${escapeHtml(winner.name)} 🎉</div>`;
            if (points === 2) {
                winnerHtml += `<div class="winner-points">💥 TOUT PILE — 2 POINTS !</div>`;
            } else {
                winnerHtml += `<div class="winner-points">+${points} point</div>`;
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

        // Scroll
        resultSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Determine and display for Supabase (completed episodes)
    async function determineWinner() {
        if (!state.endTime && state.endTime !== 0) return;

        const { winner, points, allInvalidated } = computeWinner(state.bets, state.endTime);
        renderResultUI(winner, points, allInvalidated);
        spawnConfetti();
    }

    // ---- Leaderboard Rendering (Supabase vs Local) ----
    async function renderLeaderboard() {
        let players = [];

        if (state.isSupabaseConnected && supabase) {
            try {
                // Fetch predictions and players
                const { data, error } = await supabase
                    .from('predictions')
                    .select('points_won, is_winner, is_tout_pile, gap_minutes, players(name)');

                if (error) throw error;

                // Group by player
                const totals = {};
                data.forEach(p => {
                    const name = p.players.name;
                    if (!totals[name]) {
                        totals[name] = { name, points: 0, wins: 0, toutpile: 0, totalGap: 0 };
                    }
                    totals[name].points += p.points_won;
                    if (p.is_winner) totals[name].wins += 1;
                    if (p.is_tout_pile) totals[name].toutpile += 1;
                    if (p.is_winner && p.gap_minutes != null) totals[name].totalGap += p.gap_minutes;
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
                totalGap: localLb[name].totalGap || 0
            }));
        }

        if (players.length === 0) {
            leaderboardContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📊</div>
                    <p>Aucune partie jouée pour l'instant.</p>
                </div>
            `;
            return;
        }

        // Sort: Points desc → Wins desc → Tout pile desc → Écart moyen asc (plus proche = mieux)
        players.sort((a, b) => {
            if (b.points !== a.points) return b.points - a.points;
            if (b.wins !== a.wins) return b.wins - a.wins;
            if (b.toutpile !== a.toutpile) return b.toutpile - a.toutpile;
            const aAvg = a.wins > 0 ? a.totalGap / a.wins : 9999;
            const bAvg = b.wins > 0 ? b.totalGap / b.wins : 9999;
            if (aAvg !== bAvg) return aAvg - bAvg;
            return a.name.localeCompare(b.name);
        });

        let html = `
            <table class="leaderboard-table">
                <thead>
                    <tr>
                        <th>Rang</th>
                        <th>Joueur</th>
                        <th class="lb-col-center">Points</th>
                        <th class="lb-col-center">Victoires</th>
                        <th class="lb-col-center">Tout Pile</th>
                    </tr>
                </thead>
                <tbody>
        `;

        players.forEach((p, idx) => {
            const rank = idx + 1;
            let rankClass = '';
            if (rank <= 3) rankClass = `rank-${rank}`;

            html += `
                <tr>
                    <td class="lb-rank ${rankClass}">${rank}</td>
                    <td class="lb-name">${escapeHtml(p.name)}</td>
                    <td class="lb-points lb-col-center">${p.points}</td>
                    <td class="lb-victories lb-col-center">${p.wins}</td>
                    <td class="lb-toutpile lb-col-center">${p.toutpile}</td>
                </tr>
            `;
        });

        html += `
                </tbody>
            </table>
        `;

        if (isAdmin) {
            html += `<button class="btn-clear-lb" id="btnClearLb">Réinitialiser le classement général</button>`;
        }

        leaderboardContainer.innerHTML = html;
    }

    // Event delegation for leaderboard clear button (avoids re-attaching listeners)
    leaderboardContainer.addEventListener('click', async (e) => {
        const btn = e.target.closest('#btnClearLb');
        if (!btn || !isAdmin) return;

        if (confirm('⚠️ Voulez-vous vraiment réinitialiser tout le classement général à zéro ?')) {
            if (state.isSupabaseConnected && supabase) {
                try {
                    // Reset scores on all predictions without deleting the history via RPC
                    const { error } = await supabase.rpc('admin_reset_leaderboard');
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
    async function verifyAdminAccess() {
        if (sessionStorage.getItem('jdh_admin_verified') === 'true') return true;
        const pw = prompt('Mot de passe administrateur :');
        if (!pw) return false;
        if (state.isSupabaseConnected && supabase) {
            try {
                const { data, error } = await supabase.rpc('verify_admin_password', { pw });
                if (error) throw error;
                if (data === true) {
                    sessionStorage.setItem('jdh_admin_verified', 'true');
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
        // Offline fallback: accept any non-empty password (admin can manage local game)
        sessionStorage.setItem('jdh_admin_verified', 'true');
        return true;
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
                    let { error: rpcError } = await supabase.rpc('admin_activate_episode', { ep_number: val });
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

        // Code generator button
        const btnGenCode = document.getElementById('btnGenCode');
        if (btnGenCode) {
            btnGenCode.addEventListener('click', async () => {
                const newCode = String(Math.floor(1000 + Math.random() * 9000));
                if (state.isSupabaseConnected && supabase && state.episodeId) {
                    const { error } = await supabase.rpc('admin_update_bet_code', { ep_id: state.episodeId, new_code: newCode });
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
                        const { error } = await supabase.rpc('admin_create_episode', { ep_number: nextEp, ep_bet_code: newCode });
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
                    saveActiveGameLocally();
                    markRenderDirty();
                    renderPlayers();
                    renderTimeline();
                    showSections();
                    updateClock();
                    episodeLabel.textContent = `ÉPISODE ${nextEp}`;
                    episodeNumberInput.value = nextEp;
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
                const { error: predError } = await supabase.rpc('admin_delete_episode_predictions', { ep_id: state.episodeId });
                if (predError) throw predError;

                // Reopen episode via RPC
                const { error: epError } = await supabase.rpc('admin_reactivate_episode', { ep_id: state.episodeId });
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
                .filter(b => b.minutes <= now.totalMinutes)
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
        episodeLabel.textContent = `ÉPISODE ${state.episodeNumber}`;
        if (wantsAdmin) {
            episodeNumberInput.value = state.episodeNumber;
        }

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
            determineWinner();
        }

        // Start ticking every second
        setInterval(tick, 1000);
        // Sync server time every 5 minutes
        setInterval(fetchServerTime, 5 * 60 * 1000);
    }

    init();
})();
