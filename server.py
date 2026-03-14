import sys
import json
from flask import Flask, render_template
from flask_sock import Sock
import tensorflow as tf
import tensorflow_hub as hub
import numpy as np
import librosa
import csv
from pydub import AudioSegment
import io
import subprocess
import ssl

# --- Flask App and WebSocket Setup ---
app = Flask(__name__, static_folder='..\\web', static_url_path='')
sock = Sock(app)
clients = set()
# Per-client PCM buffers for sliding-window detection
pcm_buffers = {}
# Per-client reported sample rates (from client)
pcm_sample_rates = {}

# --- YAMNet Model Loading ---
print("YAMNet 모델 로드 중...")
try:
    yamnet_model_handle = 'https://tfhub.dev/google/yamnet/1'
    yamnet_model = hub.load(yamnet_model_handle)
    print("YAMNet 모델 로드 완료.")
except Exception as e:
    print(f"YAMNet 모델 로드 중 오류 발생: {e}")
    sys.exit(1)

# --- YAMNet Class Names Loading ---
class_map_path = yamnet_model.class_map_path().numpy().decode('utf-8')
class_names = []
try:
    with open(class_map_path, 'r', encoding='utf-8') as csvfile:
        reader = csv.reader(csvfile)
        next(reader)
        for row in reader:
            if len(row) > 2:
                class_names.append(row[2])
    print(f"YAMNet 클래스 {len(class_names)}개 로드 완료.")
except Exception as e:
    print(f"YAMNet 클래스 맵 파일을 로드하는 중 오류 발생: {e}")
    sys.exit(1)

# --- Korean Label Mapping ---
KOREAN_LABELS = {
    'Vehicle': '차량',
    'Car': '자동차',
    'Motor vehicle (road)': '도로 차량',
    'Traffic noise, roadway noise': '도로 소음',
    'Vehicle horn, car horn, honking': '경적',
    'Emergency vehicle': '긴급차량',
    'Police car (siren)': '경찰차 사이렌',
    'Ambulance (siren)': '구급차 사이렌',
    'Fire engine, fire truck (siren)': '소방차 사이렌',
    'Screaming': '비명',
    'Shout': '고함',
    'Explosion': '폭발',
    'Gunshot, gunfire': '총성',
    'Machine gun': '기관총',
    'Artillery fire': '포격',
}

# --- Dangerous Sound Classes and Threshold ---
DANGEROUS_SOUND_CLASSES = [
    'Vehicle', 'Car', 'Motor vehicle (road)', 'Traffic noise, roadway noise',
    'Horn', 'Car horn, automobile horn', 'Vehicle horn, car horn, honking',
    'Emergency vehicle', 'Police car (siren)', 'Ambulance (siren)',
    'Fire engine, fire truck (siren)', 'Siren', 'Bicycle bell',
    'Brake squeal', 'Skidding', 'Explosion', 'Engine knocking'
]
# 위험도에 따른 차등 임계값 적용
DANGER_THRESHOLDS = {
    'Vehicle horn, car horn, honking': 0.25,  # 경적
    'Emergency vehicle': 0.25,                # 긴급차량
    'Police car (siren)': 0.25,              # 경찰차
    'Ambulance (siren)': 0.25,               # 구급차
    'Fire engine, fire truck (siren)': 0.25, # 소방차
    'Explosion': 0.2,                        # 폭발
    'Brake squeal': 0.3,                     # 브레이크
    'Skidding': 0.3,                         # 미끄러짐
    'default': 0.4                           # 기본 임계값
}

# --- Audio Stream Settings ---
TARGET_SAMPLERATE = 16000
# Detection window (seconds) and hop for sliding-window processing
DETECTION_WINDOW_SECONDS = 1.0  # reduced window for faster responsiveness
DETECTION_HOP_SECONDS = 0.5
# Keep max buffer to avoid unbounded growth
BUFFER_MAX_SECONDS = 6

def detect_dangerous_sounds(waveform):
    """
    YAMNet을 사용하여 waveform에서 특정 위험 소리를 감지합니다.
    (디버깅을 위해 상위 예측 클래스 출력 기능 포함)
    """
    # YAMNet 모델은 float32 타입의 waveform을 기대합니다.
    waveform_tf = tf.convert_to_tensor(waveform, dtype=tf.float32)

    scores, embeddings, log_mel_spectrogram = yamnet_model(waveform_tf)
    
    mean_scores = np.mean(scores.numpy(), axis=0) # 전체 오디오에 대한 평균 스코어

    detected_dangerous_events = []
    is_danger_detected = False
    
    if not class_names:
        print("경고: YAMNet 클래스 이름이 로드되지 않아 특정 소리 분류를 건너뜁니다.", file=sys.stderr)
        return False, []
        
    # 위험 소리 감지 시 한글 레이블로 변환
    def get_korean_label(class_name):
        return KOREAN_LABELS.get(class_name, class_name)  # 매핑이 없으면 원래 이름 사용

    # --- 추가된 디버깅 출력 부분 시작 ---
    print("\n--- YAMNet 상위 예측 클래스 ---")
    top_n_debug = 5 # 상위 5개 클래스를 출력
    # mean_scores 배열에서 가장 높은 점수를 가진 인덱스를 내림차순으로 정렬
    top_class_indices = np.argsort(mean_scores)[::-1][:top_n_debug]

    for i, idx in enumerate(top_class_indices):
        if idx < len(class_names): # 클래스 인덱스가 유효한 범위 내에 있는지 확인
            print(f"  {i+1}. {class_names[idx]}: {mean_scores[idx]:.4f}")
        else:
            print(f"  {i+1}. 알 수 없는 클래스 (인덱스: {idx}): {mean_scores[idx]:.4f}")
    print("----------------------------")
    # --- 추가된 디버깅 출력 부분 끝 ---

    for i, class_name in enumerate(class_names):
        if i >= len(mean_scores):  # IndexError 방지
            continue 

        if class_name in DANGEROUS_SOUND_CLASSES:
            score = mean_scores[i]
            # 소리 종류별 임계값 적용
            threshold = DANGER_THRESHOLDS.get(class_name, DANGER_THRESHOLDS['default'])
            
            # 디버그 출력
            if score >= 0.1:  # 낮은 점수는 출력하지 않음
                print(f"확인된 소리: {class_name} - 점수: {score:.4f} (임계값: {threshold})")
            
            if score >= threshold:
                # 한글 레이블로 변환하여 추가
                korean_label = get_korean_label(class_name)
                # Ensure score is a native Python float for JSON serialization
                detected_dangerous_events.append({
                    'class': korean_label,
                    'score': float(score)
                })
                is_danger_detected = True
    
    return is_danger_detected, detected_dangerous_events

@app.route('/')
def index():
    return app.send_static_file('index.html')
    

@sock.route('/ws')
def ws(sock):
    clients.add(sock)
    print(f"클라이언트 연결: {sock}")
    try:
        while True:
            data = sock.receive()
            # Text control messages (JSON) e.g. format announcement
            if isinstance(data, str):
                try:
                    msg = json.loads(data)
                    if msg.get('type') == 'format':
                        sr = int(msg.get('sampleRate', TARGET_SAMPLERATE))
                        pcm_sample_rates[sock] = sr
                        pcm_buffers.setdefault(sock, np.array([], dtype=np.float32))
                        print(f"클라이언트가 보고한 sampleRate: {sr}")
                        continue
                except Exception as e:
                    print(f"클라이언트 텍스트 메시지 파싱 실패: {e}")

            # Binary audio data: expect raw Float32 PCM from client
            if isinstance(data, (bytes, bytearray)):
                try:
                    print(f"Received audio data chunk, size: {len(data)} bytes") # Debug print

                    samples = np.frombuffer(data, dtype=np.float32)

                    # Resample if client sample rate differs
                    client_sr = pcm_sample_rates.get(sock, None)
                    if client_sr and client_sr != TARGET_SAMPLERATE and samples.size > 0:
                        try:
                            samples = librosa.resample(samples, orig_sr=client_sr, target_sr=TARGET_SAMPLERATE)
                        except Exception as e:
                            print(f"Resampling 실패: {e}")

                    # Append decoded samples to this client's buffer and run sliding-window detection
                    buf = pcm_buffers.get(sock, np.array([], dtype=np.float32))
                    if samples.size > 0:
                        buf = np.concatenate((buf, samples))

                    # Debug: print buffer length in seconds to help trace accumulation
                    buf_seconds = buf.size / float(TARGET_SAMPLERATE)
                    print(f"버퍼 길이: {buf.size} samples (~{buf_seconds:.3f} sec)")

                    # Trim buffer to max allowed length
                    max_len = int(BUFFER_MAX_SECONDS * TARGET_SAMPLERATE)
                    if buf.size > max_len:
                        buf = buf[-max_len:]

                    window_len = int(DETECTION_WINDOW_SECONDS * TARGET_SAMPLERATE)
                    hop_len = int(DETECTION_HOP_SECONDS * TARGET_SAMPLERATE)

                    # Process as many windows as available (with hop)
                    processed_any = False
                    while buf.size >= window_len:
                        window = buf[:window_len]
                        is_danger, detected_events = detect_dangerous_sounds(window)
                        processed_any = True

                        if is_danger:
                            ts = subprocess.check_output(['powershell', '-Command', 'Get-Date -Format o'], stderr=subprocess.DEVNULL).decode('utf-8').strip() if sys.platform.startswith('win') else ''
                            print(f"[{ts}] !!! 위험 소리 감지 !!!------------------------------------------")
                            for event in detected_events:
                                threshold = DANGER_THRESHOLDS.get(event['class'], DANGER_THRESHOLDS['default'])
                                print(f"  - {event['class']}: {event['score']:.4f} (임계값 {threshold})")

                            # Broadcast to all connected clients
                            for client in clients:
                                try:
                                    client.send(json.dumps({'type': 'danger', 'events': detected_events}))
                                except Exception as e:
                                    print(f"클라이언트에게 메시지 전송 중 오류 발생: {e}")
                        else:
                            print("(no danger in this window)")

                        # advance buffer by hop
                        buf = buf[hop_len:]

                    # save back trimmed buffer
                    pcm_buffers[sock] = buf

                    if not processed_any:
                        # Not enough data yet for a full window; helpful debug
                        print(f"버퍼에 샘플이 누적 중 (현재 길이: {buf.size} samples, {buf_seconds:.3f} sec)")
                except Exception as e:
                    print(f"오디오 처리 중 오류 발생: {e}")
                    print("오디오 처리 중 오류가 발생했습니다.")

    except Exception as e:
        print(f"클라이언트 연결 종료: {e}")
    finally:
        clients.remove(sock)
        try:
            del pcm_buffers[sock]
        except Exception:
            pass

if __name__ == "__main__":
    print("\n=== 중요 안내 ===")
    print("1. PC에서 접속 시: https://localhost:5000")
    print("2. 휴대폰으로 접속 시: https://192.168.0.17:5000")
    print("3. 마이크 접근을 위해 보안 경고창이 뜨면 '고급' -> '계속 진행' 선택")
    print("===============\n")
    
    try:
        app.run(
            host='0.0.0.0', 
            port=5000, 
            ssl_context=('cert.pem', 'key.pem'), 
            debug=False # HTTPS 환경에서 debug=False
        )
    except ssl.SSLError as e:
        # SSL 인증서 관련 오류 잡음
        print(f"\n[SSL 인증서 오류] 서버 실행 실패: {e}", file=sys.stderr)
        print("-> 'cert.pem'과 'key.pem' 파일이 유효한지, 'pyOpenSSL'이 설치되었는지 확인하세요.", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        # 파일 경로 오류 잡음
        print("\n[파일 경로 오류] cert.pem 또는 key.pem 파일을 찾을 수 없습니다.", file=sys.stderr)
        print("-> generate_cert.py를 실행하여 두 파일이 server.py와 같은 폴더에 있는지 확인하세요.", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        # 그 외 모든 오류
        print(f"\n[치명적인 오류 발생] 서버 실행 실패: {e}", file=sys.stderr)
        print("-> 이는 pyOpenSSL 설치 오류일 가능성이 가장 높습니다. 2단계로 이동하세요.", file=sys.stderr)
        sys.exit(1)