// SafeRide App JavaScript
class SafeRideApp {
    constructor() {
        // 개발/테스트용: 앱 첫 실행 시 localStorage의 rideHistory를 자동 초기화
        if (!localStorage.getItem('saferide-history')) {
            localStorage.removeItem('saferide-history');
        }
        this.alerts = [];
        this.isConnected = true;
        this.emergencyMode = false;
        this.alertCount = 0;
        // alert dedupe/cooldown and recent severe events tracker
        this.lastAlertTimes = {};
        this.alertCooldownSeconds = 4; // same class alerts suppressed within this window
        this.recentSevereEvents = [];
        
        // 주행 관련 상태
        this.isWarningSoundPlaying = false;
        this.activeRide = null;
        this.rideTimer = null;
        
        this.settings = {
            notifications: true,
            sound: true,
            darkMode: true  // 다크모드 기본값 true
        };
        
        this.activeRide = null;
        this.rideHistory = [];
        
        this.pausedDuration = 0;  // 일시정지된 총 시간을 저장할 변수 추가
        this.lastPauseTime = null;  // 마지막 일시정지 시간을 저장할 변수 추가
        
        this.map = null;
        this.mapInitialized = false;
        this.currentLocation = null;

        this.init();
        this.loadSettings();
        this.loadRideHistory();
    }

    initMap() {
        const mapContainer = document.getElementById('map');
        const mapOption = {
            center: new kakao.maps.LatLng(37.566826, 126.9786567),
            level: 1,
            draggable: true,
            zoomable: true
        };

        this.map = new kakao.maps.Map(mapContainer, mapOption);

        kakao.maps.event.addListener(this.map, 'click', () => {
            const offsetPos = this.getOffsetLocation();
            if (offsetPos) {
                this.map.panTo(offsetPos);
                this.showToast('현재 위치로 이동합니다.', 'fas fa-location-arrow');
            }
        });

        const content = document.createElement('div');
        content.className = 'heading_marker';
        this.customOverlay = new kakao.maps.CustomOverlay({
            map: this.map,
            position: mapOption.center,
            content: content,
            yAnchor: 0.5,
            xAnchor: 0.5
        });

        if (navigator.geolocation) {
            navigator.geolocation.watchPosition(pos => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                const newPos = new kakao.maps.LatLng(lat, lon);
                this.currentLocation = newPos; // 현재 위치 저장
                this.customOverlay.setPosition(newPos);
                
                const offsetPos = this.getOffsetLocation();
                if (offsetPos) {
                    this.map.panTo(offsetPos);
                }
            }, err => console.warn('위치 오류:', err.message), {
                enableHighAccuracy: true, maximumAge: 0, timeout: 5000
            });
        }
    }

    getOffsetLocation() {
        if (!this.currentLocation) return null;

        const lat = this.currentLocation.getLat();
        const lon = this.currentLocation.getLng();
        const offset = -0.0002; // Negative to move map center south, making marker appear higher
        return new kakao.maps.LatLng(lat + offset, lon);
    }

    async init() {
        this.updateTime();
        this.setupEventListeners();
        this.setupNavigation();
        this.setupMapClickEvent(); // 맵 클릭 이벤트 추가
        // WebSocket을 연 뒤에 오디오 스트리밍을 시작하도록 변경
        await this.setupWebSocket(); // WebSocket 설정 및 연결 완료 대기
        await this.startAudioStreaming(); // 오디오 스트리밍 시작
        this.updateAlertCount(); // 알림 카운트 초기화
        
        // 초기 화면 설정
        this.navigateToPage('home');
    }

    setupWebSocket() {
        // 이 함수는 연결이 완료될 때까지 대기하는 Promise를 반환합니다.
        return new Promise((resolve, reject) => {
            // Get the current host and protocol
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsHost = window.location.hostname;
            const wsPort = window.location.port || '5000';
            const wsUrl = `${wsProtocol}//${wsHost}:${wsPort}/ws`;
            console.log('Connecting to WebSocket:', wsUrl);
            this.socket = new WebSocket(wsUrl);

            this.socket.onopen = () => {
                console.log('WebSocket connection established.');
                this.showToast('서버에 연결되었습니다.', 'fas fa-check-circle');
                this.isConnected = true;
                this.updateConnectionStatus();
                resolve();
            };

            this.socket.onmessage = (event) => {
                // 디버그: 수신 메시지 타입 로그
                try {
                    if (typeof event.data === 'string') {
                        console.debug('[WS] received string message (truncated):', event.data.slice(0, 300));
                        const data = JSON.parse(event.data);
                        if (data.type === 'danger') {
                            console.debug('[WS] danger message events:', data.events);
                            this.handleDangerAlert(data.events);
                        }
                    } else {
                        console.debug('[WS] received non-string message, type:', typeof event.data, event.data);
                    }
                } catch (err) {
                    console.warn('수신한 메시지 파싱 실패:', err, 'raw:', event.data);
                }
            };

        this.socket.onclose = () => {
            console.log('WebSocket connection closed. Reconnecting...');
            this.showToast('서버와 연결이 끊어졌습니다. 재연결을 시도합니다.', 'fas fa-exclamation-triangle');
            this.isConnected = false;
            this.updateConnectionStatus();
            setTimeout(() => this.setupWebSocket(), 3000); // 3초 후 재연결 시도
        };

        this.socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.showToast('서버 연결에 오류가 발생했습니다.', 'fas fa-times-circle');
            this.isConnected = false;
            this.updateConnectionStatus();
            reject && reject(error);
        };
        });
    }

    handleDangerAlert(events) {
        const now = Date.now();
        console.debug('[handleDangerAlert] events received:', events);
        if (!events || !Array.isArray(events) || events.length === 0) {
            console.debug('[handleDangerAlert] no events to handle');
            return;
        }

        events.forEach(event => {
            const className = event.class || 'Unknown';
            const score = typeof event.score === 'number' ? event.score : 0;

            // cooldown per sound class to avoid spamming
            const last = this.lastAlertTimes[className] || 0;
            if (now - last < this.alertCooldownSeconds * 1000) {
                console.debug('[handleDangerAlert] Cooldown: skip duplicate alert for', className, 'now-last=', now-last);
                return;
            }
            this.lastAlertTimes[className] = now;

            const hazard = {
                type: this.mapSoundToType(className),
                icon: this.mapSoundToIcon(className),
                color: this.mapSoundToColor(className),
                message: `위험 소리 감지: ${className}`
            };

            // visual highlight on map
            this.highlightIndicator(hazard.type);

            // 위험 감지 처리: addHazardAlert가 activeRide 카운트와 상세기록을 관리합니다
            this.addHazardAlert(hazard);
            // 실시간 UI/통계는 addHazardAlert 내부에서 상태를 갱신하므로 별도 처리 불필요

            // play a warning sound and send system notification if enabled
            this.playSound('warning');
            this.showNotification(hazard.message);

            // If high-confidence siren/ambulance events cluster, show emergency modal
            if (score >= 0.7 && (className.includes('Siren') || className.includes('Ambulance') || className.includes('Police'))) {
                this.recentSevereEvents.push(now);
                // keep only the last 10 seconds
                const cutoff = now - 10 * 1000;
                this.recentSevereEvents = this.recentSevereEvents.filter(t => t >= cutoff);
                if (this.recentSevereEvents.length >= 2) {
                    // trigger emergency UI
                    this.showEmergencyModal();
                    // reset tracker to avoid repeated modals
                    this.recentSevereEvents = [];
                }
            }

            // 마지막에 한 번만 알림 추가 (중복 호출 제거)
            // this.addHazardAlert(hazard);
        });
    }

    highlightIndicator(type) {
        const el = document.querySelector(`.danger-indicator[data-type="${type}"]`);
        if (!el) return;
        el.classList.add('active');
        // remove after a short time
        setTimeout(() => el.classList.remove('active'), 3000);
    }

    clearAllAlerts() {
        // 알림 목록 비우기
        this.alerts = [];
        this.alertCount = 0;
        
        // UI 업데이트
        const alertList = document.getElementById('alertList');
        if (alertList) {
            alertList.innerHTML = '';
        }
        this.updateAlertCount();
        
        // 알림음 재생
        this.playSound('clear');
        
        // 토스트 메시지 표시
        this.showToast('모든 알림이 삭제되었습니다.', 'fas fa-check-circle');
    }

    mapSoundToType(soundClass) {
        if (soundClass.includes('Car') || soundClass.includes('Vehicle')) return 'car';
        if (soundClass.includes('Horn')) return 'horn';
        if (soundClass.includes('Siren') || soundClass.includes('Ambulance') || soundClass.includes('Police')) return 'siren';
        return 'unknown';
    }

    mapSoundToIcon(soundClass) {
        if (soundClass.includes('Car') || soundClass.includes('Vehicle')) return 'fas fa-car';
        if (soundClass.includes('Horn')) return 'fas fa-volume-up';
        if (soundClass.includes('Siren') || soundClass.includes('Ambulance') || soundClass.includes('Police')) return 'fas fa-ambulance';
        return 'fas fa-exclamation-triangle';
    }

    mapSoundToColor(soundClass) {
        if (soundClass.includes('Car') || soundClass.includes('Vehicle')) return '#ff6b6b';
        if (soundClass.includes('Horn')) return '#ffa726';
        if (soundClass.includes('Siren') || soundClass.includes('Ambulance') || soundClass.includes('Police')) return '#ef5350';
        return '#888888';
    }

    // 시간 업데이트
    updateTime() {
        const timeElement = document.querySelector('.time');
        const updateTime = () => {
            const now = new Date();
            const timeString = now.toLocaleTimeString('ko-KR', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
            timeElement.textContent = timeString;
        };
        
        updateTime();
        setInterval(updateTime, 1000);
    }

    // 설정 로드
    loadSettings() {
        // 저장된 설정이 있으면 불러오기
        const savedSettings = localStorage.getItem('saferide-settings');
        if (savedSettings) {
            this.settings = JSON.parse(savedSettings);
        }
        
        // 설정값 적용
        this.applySettings();
        this.updateSettingsUI();
    }

    // 설정값 저장
    saveSettings() {
        localStorage.setItem('saferide-settings', JSON.stringify(this.settings));
        this.applySettings();
    }

    // 설정값 UI 업데이트
    updateSettingsUI() {
        const settingsPage = document.getElementById('settingsPage');
        if (!settingsPage) return;

        // 각 설정 체크박스 상태 업데이트
        const checkboxes = settingsPage.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(checkbox => {
            const setting = checkbox.closest('.setting-item').getAttribute('data-setting');
            if (setting) {
                checkbox.checked = this.settings[setting];
            }
        });
    }

    // 설정값 적용
    applySettings() {
        // 다크모드 적용
        document.body.classList.toggle('dark-mode', this.settings.darkMode);
        

    }

    // 이벤트 리스너 설정
    setupEventListeners() {
        // 비상 버튼
        const emergencyBtn = document.getElementById('emergencyBtn');
        if (emergencyBtn) {
            emergencyBtn.addEventListener('click', () => this.showEmergencyModal());
        }

        // 알림 전체 삭제 버튼
        const clearBtn = document.getElementById('clearAlerts');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearAllAlerts());
        }



        // 알림 패널 클릭
        const alertPanel = document.querySelector('.alert-panel');
        if (alertPanel) {
            alertPanel.addEventListener('click', () => this.showAllAlerts());
        }

        // 설정 변경 이벤트
        const settingsPage = document.getElementById('settingsPage');
        if (settingsPage) {
            const checkboxes = settingsPage.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach(checkbox => {
                const settingItem = checkbox.closest('.setting-item');
                if (settingItem) {
                    const setting = settingItem.getAttribute('data-setting');
                    checkbox.addEventListener('change', (e) => {
                        this.settings[setting] = e.target.checked;
                        this.saveSettings();
                        this.showToast(`${setting} ${e.target.checked ? '활성화' : '비활성화'}`);
                    });
                }
            });
        }
    }

    // 위험 알림 추가
    getRandomLocation() {
        const locations = ['후방', '좌측', '우측'];
        return locations[Math.floor(Math.random() * locations.length)];
    }

    addHazardAlert(hazard) {
        console.debug('[addHazardAlert] called with hazard:', hazard);
        const alert = {
            id: Date.now(),
            type: hazard.type,
            icon: hazard.icon,
            color: hazard.color,
            message: hazard.message,
            location: this.getRandomLocation(),
            timestamp: new Date(),
            distance: Math.floor(Math.random() * 100) + 10
        };

    this.alerts.unshift(alert);
        // 주행 중이고 일시정지 상태가 아니면 activeRide에 카운트 및 상세 기록 추가
        if (this.activeRide && !this.activeRide.isPaused) {
            this.activeRide.hazardCount++;
            if (!this.activeRide.hazardAlerts) this.activeRide.hazardAlerts = [];
            this.activeRide.hazardAlerts.push({
                type: hazard.type,
                time: new Date(),
                details: hazard.message
            });
        }
    this.alertCount++;
    // UI: 주행 중이면 헤더의 alertCount는 activeRide 카운트로 동기화
    this.updateAlertCount();
        this.updateAlertList();
        // UI: 주행 패널 및 통계 표시 동기화
        this.updateRideDisplay();
        console.log('[addHazardAlert] alertCount=', this.alertCount, 'activeRide.hazardCount=', this.activeRide ? this.activeRide.hazardCount : null);
        // 토스트 메시지: 항상 간단한 경고명(예: '경적', '응급차', '차량')만 표시
        const TOAST_LABELS = {
            horn: '경적',
            siren: '응급차',
            car: '차량',
            unknown: '위험'
        };
        const toastLabel = TOAST_LABELS[hazard.type] || '경고';
        this.showToast(toastLabel, hazard.icon);
        this.triggerVibration();
    }

    // 알림 개수 업데이트
    updateAlertCount() {
        const alertCountElement = document.getElementById('alertCount');
        if (alertCountElement) {
            // 홈(실시간 위험 감지) 패널은 항상 전체 누적 카운트만 표시
            alertCountElement.textContent = this.alertCount || 0;
        }
    }

    // 알림 목록 업데이트
    updateAlertList() {
        const alertList = document.getElementById('alertList');
        if (!alertList) return;

        alertList.innerHTML = '';
        
        this.alerts.forEach(alert => {
            const alertItem = this.createAlertItem(alert);
            alertList.appendChild(alertItem);
        });
    }

    // 알림 아이템 생성
    createAlertItem(alert) {
        const alertItem = document.createElement('div');
        alertItem.className = 'alert-item';
        alertItem.innerHTML = `
            <div class="alert-icon ${alert.type}" style="background: ${alert.color}">
                <i class="${alert.icon}"></i>
            </div>
            <div class="alert-info">
                <h4>${alert.message}</h4>
                <p>${this.formatFullTimestamp(alert.timestamp)}</p>
            </div>
        `;
        
        alertItem.addEventListener('click', () => this.showAlertDetails(alert));
        return alertItem;
    }



    // 비상 모달 표시
    showEmergencyModal() {
        const modal = document.getElementById('emergencyModal');
        if (modal) {
            modal.style.display = 'flex';
            this.emergencyMode = true;
            this.triggerVibration();
            this.showToast('비상 상황이 감지되었습니다!', 'fas fa-exclamation-triangle');
        }
    }

    // 긴급 전화
    callEmergency() {
        // 실제 전화 걸기 대신 전화 앱에 119를 입력한 상태로 진입
        window.location.href = 'tel:119';
        this.showToast('긴급 전화 준비 중...', 'fas fa-phone');
        // 모달은 사용자가 직접 닫도록 변경 (자동 닫기 제거)
        // setTimeout(() => {
        //     this.closeEmergency();
        // }, 2000);
    }

    // 비상 모달 닫기
    closeEmergency() {
        const modal = document.getElementById('emergencyModal');
        if (modal) {
            modal.style.display = 'none';
            this.emergencyMode = false;
        }
    }

    // 모든 알림 표시
    showAllAlerts() {
        const alertList = document.getElementById('alertList');
        if (!alertList) return;

        alertList.innerHTML = '';

        this.alerts.forEach(alert => {
            const alertItem = this.createAlertItem(alert);
            alertList.appendChild(alertItem);
        });

        this.showToast(`${this.alerts.length}개의 알림이 있습니다`, 'fas fa-bell');
    }

    // 알림 상세 정보 표시
    showAlertDetails(alert) {
        const full = this.formatFullTimestamp(alert.timestamp);
        this.showToast(`${alert.message} (${full})`, alert.icon);
    }

    // 네비게이션 설정
    setupNavigation() {
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.addEventListener('click', () => {
                const page = item.dataset.page;
                this.navigateToPage(page);
            });
        });
    }

    // 페이지 전환
    navigateToPage(page) {
        // 모든 페이지 숨기기
        const pages = ['mapPage', 'statsPage', 'settingsPage'];
        pages.forEach(p => {
            const element = document.getElementById(p);
            if (element) {
                element.style.display = 'none';
            }
        });

        const mapElement = document.getElementById('map');
        const emergencyBtn = document.getElementById('emergencyBtn');

        // 알림 패널 및 맵 배경 처리
        if (page === 'home' || page === 'map') {
            if (mapElement) mapElement.style.display = 'block';
            if (emergencyBtn) emergencyBtn.style.display = 'block';
            if (!this.mapInitialized) {
                this.initMap();
                this.mapInitialized = true;
            } else if (this.map) {
                this.map.relayout();
            }
        } else {
            if (mapElement) mapElement.style.display = 'none';
            if (emergencyBtn) emergencyBtn.style.display = 'none';
        }

        const alertPanel = document.querySelector('.alert-panel');
        if (alertPanel) {
            if (page === 'home') {
                alertPanel.style.display = 'block';
                this.updateAlertList(); // 알림 목록 업데이트
            } else {
                alertPanel.style.display = 'none';
            }
        }

        // 선택된 페이지 표시
        if (page !== 'map' && page !== 'home') { // 'map' 또는 'home' 페이지일 때는 다른 페이지를 표시하지 않음
            const targetPage = document.getElementById(page + 'Page');
            if (targetPage) {
                targetPage.style.display = 'block';
            }
        }

        // 네비게이션 아이템 상태 업데이트
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(nav => nav.classList.remove('active'));
        
        const activeNav = document.querySelector(`[data-page="${page}"]`);
        if (activeNav) {
            activeNav.classList.add('active');
        }

        // this.showToast(pageMessages[page] || '페이지를 이동합니다', 'fas fa-arrow-right');
    }

    // 토스트 알림 표시
    showToast(message, icon = 'fas fa-info-circle') {
        // 사용자가 알림을 꺼두면 토스트를 표시하지 않음
        if (this.settings && this.settings.notifications === false) return;

        const toast = document.getElementById('toast');
        if (!toast) return;

        const toastIcon = toast.querySelector('.toast-icon');
        const toastMessage = toast.querySelector('.toast-message');

        if (toastIcon && toastMessage) {
            toastIcon.className = `toast-icon ${icon}`;
            toastMessage.textContent = message;
            toast.style.display = 'block';

            setTimeout(() => {
                toast.style.display = 'none';
            }, 3000);
        }
    }

    // 진동 트리거
    triggerVibration() {
        // The vibration setting has been removed.
    }

    getGradientForScore(score) {
        let startColor, endColor;

        if (score >= 80) {
            // Green/Blue - Safe
            startColor = '#17c3b2'; // Teal
            endColor = '#4ac29a';   // Greenish Cyan
        } else if (score >= 50) {
            // Yellow/Orange - Caution
            startColor = '#ffb74d'; // Orange 300
            endColor = '#ffd54f';   // Amber 300
        } else {
            // Red/Orange - Danger
            startColor = '#ef5350'; // Red 400
            endColor = '#ff7043';   // Deep Orange 400
        }
        return `linear-gradient(90deg, ${startColor}, ${endColor})`;
    }

    // 연결 상태 업데이트
    updateConnectionStatus() {
        const statusDot = document.querySelector('.status-dot');
        const statusText = document.querySelector('.status-text');
        
        if (statusDot && statusText) {
            if (this.isConnected) {
                statusDot.style.background = '#4caf50';
                statusText.textContent = '연결됨';
            } else {
                statusDot.style.background = '#ff6b6b';
                statusText.textContent = '연결 끊김';
            }
        }
    }

    // 연결 상태 토글 (테스트용)
    toggleConnection() {
        this.isConnected = !this.isConnected;
        this.updateConnectionStatus();
        this.showToast(
            this.isConnected ? '연결이 복구되었습니다' : '연결이 끊어졌습니다',
            this.isConnected ? 'fas fa-wifi' : 'fas fa-exclamation-triangle'
        );
    }

    // 맵 클릭 이벤트 설정
    setupMapClickEvent() {
        const mapBackground = document.querySelector('.map-background');
        if (mapBackground) {
            mapBackground.style.cursor = 'pointer';  // 클릭 가능함을 표시
            mapBackground.addEventListener('click', () => {
                this.navigateToPage('map');
            });
        }
    }

    // 알림 표시
    showNotification(message) {
        if (!this.settings.notifications) return;
        
        if ("Notification" in window) {
            Notification.requestPermission().then(permission => {
                if (permission === "granted") {
                    new Notification("SafeRide 알림", { body: message });
                }
            });
        }
    }

    // 소리 재생
    playSound(type) {
        if (!this.settings.sound) return;

        if (type === 'warning' && this.isWarningSoundPlaying) {
            return; // 이미 경고음이 재생 중이면 중복 재생 방지
        }

        const sounds = {
            alert: 'beep.mp3',
            warning: 'warning.mp3',
            emergency: 'emergency.mp3'
        };

        const audio = new Audio(`sounds/${sounds[type]}`);

        if (type === 'warning') {
            this.isWarningSoundPlaying = true;
            audio.onended = () => {
                this.isWarningSoundPlaying = false;
            };
        }

        audio.play();
    }

    // 주행 기록 로드
    loadRideHistory() {
        const savedHistory = localStorage.getItem('saferide-history');
        if (savedHistory) {
            this.rideHistory = JSON.parse(savedHistory);
            this.updateStatsVisibility();
        }
    }

    // 오디오 스트리밍 시작
    async startAudioStreaming() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // AudioContext + ScriptProcessor 방식으로 raw Float32 PCM 전송
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioCtx();
            this.micStream = stream;
            this.sourceNode = this.audioContext.createMediaStreamSource(stream);

            const bufferSize = 4096;
            // createScriptProcessor channels: 1 input, 1 output
            this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

            this.processor.onaudioprocess = (event) => {
                const input = event.inputBuffer.getChannelData(0);
                // copy to transferable Float32Array
                const float32 = new Float32Array(input.length);
                float32.set(input);

                // announce sampleRate once
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    if (!this._formatAnnounced) {
                        try {
                            this.socket.send(JSON.stringify({ type: 'format', sampleRate: this.audioContext.sampleRate }));
                            this._formatAnnounced = true;
                        } catch (e) {
                            console.warn('format announce failed', e);
                        }
                    }

                    try {
                        this.socket.send(float32.buffer);
                        console.debug('[audio] sent chunk — bytes:', float32.byteLength, 'samples:', float32.length, 'sr:', this.audioContext.sampleRate);
                    } catch (e) {
                        console.warn('오디오 청크 전송 실패:', e);
                    }
                }
            };

            this.sourceNode.connect(this.processor);
            // keep processor alive; we don't output audio so connecting to destination is optional
            this.processor.connect(this.audioContext.destination);
            this.audioStream = stream;
        } catch (err) {
            this.showToast('마이크에 접근할 수 없습니다. 브라우저의 마이크 권한을 확인해주세요.', 'fas fa-microphone-slash');
            console.error('Error accessing microphone:', err);
        }
    }

    // 새로운 주행 시작
    startNewRide() {
        if (this.activeRide) {
            this.showToast('이미 주행 중입니다', 'fas fa-exclamation-circle');
            return;
        }

        this.activeRide = {
            startTime: new Date(),
            pauseTime: 0,
            distance: 0,
            currentSpeed: 0,
            maxSpeed: 0,
            isPaused: false,
            hazardCount: 0,
            hazardAlerts: [], // 위험 감지 기록 추가
            totalRideTime: 0, // 총 주행 시간
            path: []
        };

        // 초기 통계 표시 업데이트
        this.updateRideDisplay();
        
        // 주행 시간 업데이트를 위한 타이머 시작
        this.rideTimer = setInterval(() => {
            if (this.activeRide && !this.activeRide.isPaused) {
                this.activeRide.totalRideTime = Math.floor((Date.now() - this.activeRide.startTime) / 1000);
                this.updateRideTimeDisplay();
            }
        }, 1000);

        // GPS 위치 추적 시작
        if (navigator.geolocation) {
            this.locationWatcher = navigator.geolocation.watchPosition(
                pos => this.updateRideStats(pos),
                err => this.showToast('GPS 신호를 찾을 수 없습니다', 'fas fa-exclamation-circle'),
                { enableHighAccuracy: true }
            );
        }

        // 주행 타이머 시작
        this.startRideTimer();
        
        // 활성 주행 패널 표시
        const panel = document.getElementById('activeRidePanel');
        if (panel) {
            panel.classList.add('visible');
        }

        // 빈 통계 숨기기
        const emptyStats = document.getElementById('emptyStats');
        if (emptyStats) {
            emptyStats.style.display = 'none';
        }

        // 홈 화면으로 이동
        this.navigateToPage('home');
        
        this.showToast('주행이 시작되었습니다', 'fas fa-play');
        
        // 진동 피드백
        this.triggerVibration();
    }

    // 주행 타이머 시작
    startRideTimer() {
        if (this.rideTimer) {
            clearInterval(this.rideTimer);
        }
        
        this.rideTimer = setInterval(() => {
            if (!this.activeRide || this.activeRide.isPaused) return;
            
            const rideTime = document.getElementById('rideTime');
            const duration = this.calculateRideDuration();
            if (rideTime) {
                rideTime.textContent = this.formatDuration(duration);
            }
        }, 1000);
    }

    // 주행 통계 업데이트
    updateRideStats(position) {
        if (!this.activeRide || this.activeRide.isPaused) return;

        // 위치 데이터가 제공된 경우에만 위치 정보 업데이트
        if (position && position.coords) {
            const { latitude, longitude } = position.coords;
            this.activeRide.path.push({ latitude, longitude });
        }
        
        this.updateRideDisplay();
    }

    // 주행 표시 업데이트
    updateRideDisplay() {
        // 주행 시간 업데이트
        const rideTime = document.getElementById('rideTime');
        if (rideTime && this.activeRide) {
            const duration = this.calculateRideDuration();
            rideTime.textContent = this.formatDuration(duration);
        }

        // 위험 감지 횟수 업데이트 (주행 페이지)
        const rideHazardCount = document.querySelector('.stat-value[data-stat="hazards"]');
        if (rideHazardCount && this.activeRide) {
            rideHazardCount.textContent = `${this.activeRide.hazardCount}회`;
        }

        // 알림 패널의 위험 감지 횟수 업데이트
        const alertHazardCount = document.getElementById('hazardCount');
        if (alertHazardCount && this.activeRide) {
            alertHazardCount.textContent = `${this.activeRide.hazardCount}회`;
        }
    }

    // 주행 일시정지/재개 수정
    toggleRidePause() {
        if (!this.activeRide) return;

        const now = new Date();
        this.activeRide.isPaused = !this.activeRide.isPaused;

        if (this.activeRide.isPaused) {
            // 일시정지 시작
            this.lastPauseTime = now;
        } else {
            // 일시정지 해제
            if (this.lastPauseTime) {
                this.pausedDuration += Math.floor((now - this.lastPauseTime) / 1000);
                this.lastPauseTime = null;
            }
        }

        const pauseBtn = document.querySelector('.ride-control-btn.pause');
        if (pauseBtn) {
            pauseBtn.innerHTML = this.activeRide.isPaused ? 
                '<i class="fas fa-play"></i> 계속하기' : 
                '<i class="fas fa-pause"></i> 일시정지';
        }

        this.showToast(
            this.activeRide.isPaused ? '주행이 일시정지되었습니다' : '주행을 계속합니다',
            this.activeRide.isPaused ? 'fas fa-pause' : 'fas fa-play'
        );
    }

    // 주행 종료
    stopRide() {
        if (!this.activeRide) return;

        // 타이머 정지
        if (this.rideTimer) {
            clearInterval(this.rideTimer);
            this.rideTimer = null;
        }

        // 오디오/스트림(YAMNet)은 계속 동작해야 하므로 정리하지 않음

        // 최종 통계 계산
        const endTime = new Date();
        const durationSeconds = Math.max(1, Math.floor((endTime - this.activeRide.startTime) / 1000));
        const hazardCount = this.activeRide.hazardCount || 0;
        const minutes = durationSeconds / 60;
        const hazardsPerMinute = minutes > 0 ? (hazardCount / minutes) : hazardCount;

        // 점수 계산: 100점에서 시간(초)당 위험감지 횟수의 비율을 뺌
        const safetyScore = Math.max(0, 100 - Math.round(hazardsPerMinute * 10)); // 위험 감지 횟수가 많을수록 점수 감소



        // 주행 기록 생성
        const rideRecord = {
            startTime: this.activeRide.startTime,
            endTime: endTime,
            duration: durationSeconds,
            distance: this.activeRide.distance || 0,
            maxSpeed: this.activeRide.maxSpeed || 0,
            hazardCount: hazardCount,
            hazardAlerts: (this.activeRide.hazardAlerts || []).slice(),
            hazardsPerMinute: parseFloat(hazardsPerMinute.toFixed(2)),
            score: safetyScore
        };

        // 기록 저장
        this.rideHistory.unshift(rideRecord);
        this.saveRideHistory(); // localStorage 저장 및 통계 업데이트

        // 위치 watcher 정리
        if (this.locationWatcher) {
            navigator.geolocation.clearWatch(this.locationWatcher);
            this.locationWatcher = null;
        }

        // UI 정리 및 이동
        this.activeRide = null;
        this.hideActiveRidePanel();
        this.showToast('주행이 종료되었습니다', 'fas fa-stop');

        // 통계 페이지로 이동 (통계는 saveRideHistory -> updateStatsDisplay에서 갱신됨)
        this.navigateToPage('stats');
    }

    // 활성 주행 패널 표시/숨김
    showActiveRidePanel() {
        const panel = document.getElementById('activeRidePanel');
        if (panel) {
            panel.classList.add('visible');
        }
    }

    hideActiveRidePanel() {
        const panel = document.getElementById('activeRidePanel');
        if (panel) {
            panel.classList.remove('visible');
        }
    }

    // 통계 페이지 표시 상태 업데이트
    updateStatsVisibility() {
        const emptyStats = document.getElementById('emptyStats');
        const statsContainer = document.getElementById('statsContainer');
        
        if (emptyStats && statsContainer) {
            if (this.rideHistory.length > 0) {
                emptyStats.style.display = 'none';
                statsContainer.style.display = 'grid';
                this.updateStatsDisplay();
            } else {
                emptyStats.style.display = 'block';
                statsContainer.style.display = 'none';
            }
        }
    }

    // 통계 표시 업데이트
    updateStatsDisplay() {
        const statsContainer = document.getElementById('statsContainer');
        if (!statsContainer) return;

        let totalHazards = 0;
        let totalDuration = 0;
        let totalScore = 0;
        let rideCount = this.rideHistory.length;
        const scoreCardBig = document.querySelector('.stat-card--big');

        if (rideCount > 0) {
            this.rideHistory.forEach(ride => {
                totalHazards += ride.hazardCount || 0;
                totalDuration += ride.duration || 0;
                totalScore += (typeof ride.score === 'number') ? ride.score : 100;
            });

            const averageScore = Math.round(totalScore / rideCount);

            const elHazards = document.getElementById('statsHazards');
            const elScoreBig = document.getElementById('statsScoreBig');
            const elTime = document.getElementById('statsTime');

            if (elHazards) elHazards.textContent = `${totalHazards}회`;
            if (elScoreBig) elScoreBig.textContent = `${averageScore}점`;
            if (elTime) elTime.textContent = totalDuration === 0 ? '0초' : this.formatDuration(totalDuration);

            if (scoreCardBig) { // Apply the gradient
                scoreCardBig.style.background = this.getGradientForScore(averageScore);
            }

        } else {
            // 기록이 없을 때 기본값으로 설정
            const elHazards = document.getElementById('statsHazards');
            const elScoreBig = document.getElementById('statsScoreBig');
            const elTime = document.getElementById('statsTime');

            if (elHazards) elHazards.textContent = '0회';
            if (elScoreBig) elScoreBig.textContent = '100점';
            if (elTime) elTime.textContent = '0초';

            if (scoreCardBig) { // Reset the gradient to default
                scoreCardBig.style.background = this.getGradientForScore(100);
            }
        }
    }

    // 주행 기록 저장 메서드 수정
    saveRideHistory() {
        localStorage.setItem('saferide-history', JSON.stringify(this.rideHistory));
        this.updateStatsVisibility();
        this.updateStatsDisplay(); // 통계 업데이트 추가
    }

    // 주행 기록 초기화
    clearRideHistory() {
        this.rideHistory = [];
        localStorage.removeItem('saferide-history');
        this.updateStatsVisibility();
        this.updateStatsDisplay();
        this.showToast('주행 기록이 초기화되었습니다.', 'fas fa-trash-alt');
    }



    // 주행 시간 계산
    calculateRideDuration() {
        if (!this.activeRide) return 0;
        const now = new Date();
        
        // 기본 경과 시간 계산
        let duration = Math.floor((now - this.activeRide.startTime) / 1000);
        
        // 일시정지 중인 경우 마지막 일시정지 시간부터의 시간을 제외
        if (this.activeRide.isPaused && this.lastPauseTime) {
            duration -= Math.floor((now - this.lastPauseTime) / 1000);
        }
        
        // 이전의 일시정지 시간들을 제외
        duration -= this.pausedDuration;
        
        return Math.max(0, duration);
    }

    // 시간 형식화 수정
    formatDuration(seconds) {
        if (seconds < 60) {
            return `${seconds}초`;
        }
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        if (hours > 0) {
            return `${hours}시간 ${minutes}분`;
        } else {
            return `${minutes}분`;
        }
    }

    // 전체 타임스탬프 포맷: YYYY년 M월 D일 HH시 mm분 ss초 (두 자리 형식 보장)
    formatFullTimestamp(date) {
        if (!date) return '';
        const d = new Date(date);
        const Y = d.getFullYear();
        const M = String(d.getMonth() + 1).padStart(2, '0');
        const D = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${Y}년 ${M}월 ${D}일 ${hh}시 ${mm}분 ${ss}초`;
    }
}

// 글로벌 함수들 (HTML에서 직접 호출)
function callEmergency() {
    if (window.app) {
        app.callEmergency();
    }
}

function closeEmergency() {
    if (window.app) {
        app.closeEmergency();
    }
}

// 앱 초기화
const app = new SafeRideApp();
window.app = app; // 전역에서 접근 가능하도록

// 개발용 테스트 함수: 콘솔에서 호출하여 알림 강제 생성
function triggerHazardTest(type = 'horn') {
    if (!window.app) return;
    const map = {
        horn: { type: 'horn', icon: 'fas fa-volume-up', color: '#ffa726', message: '경적' },
        siren: { type: 'siren', icon: 'fas fa-ambulance', color: '#ef5350', message: '응급차' },
        car: { type: 'car', icon: 'fas fa-car', color: '#ff6b6b', message: '차량' }
    };
    const hazard = map[type] || map['car'];
    console.debug('[triggerHazardTest] creating hazard of type', type, hazard);
    window.app.addHazardAlert(hazard);
}

// 연결 상태 테스트 (개발용)
setInterval(() => {
    if (Math.random() < 0.1) { // 10% 확률로 연결 상태 변경
        app.toggleConnection();
    }
}, 30000);

// 키보드 단축키 (개발용)
document.addEventListener('keydown', (e) => {
    console.debug('[keydown] key pressed:', e.key);
    switch(e.key) {
        case 'e':
        case 'E':
            app.showEmergencyModal();
            break;
        case 'c':
        case 'C':
            app.toggleConnection();
            break;
        case 'h':
        case 'H':
            app.addHazardAlert({
                type: 'car',
                icon: 'fas fa-car',
                color: '#ff6b6b',
                message: '차량 접근 감지'
            });
            break;
        case '1':
            app.navigateToPage('home');
            break;
        case '2':
            app.navigateToPage('map');
            break;
        case '3':
            app.navigateToPage('stats');
            break;
        case '4':
            app.navigateToPage('settings');
            break;
    }
});

// 우클릭 금지
document.addEventListener('contextmenu', function(e) {
    e.preventDefault();
});

console.log('SafeRide 앱이 시작되었습니다!');
console.log('단축키: E(비상), C(연결), H(위험 추가), 1-4(페이지 전환)');