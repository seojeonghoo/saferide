import tensorflow as tf
import tensorflow_hub as hub
import numpy as np
import librosa
import sounddevice as sd
import time
import csv # csv 파일 파싱을 위해 추가
import sys # 프로그램 종료를 위해 추가

# --- 1. YAMNet 모델 로드 ---
print("YAMNet 모델 로드 중... (처음 실행 시 다운로드될 수 있습니다)")
yamnet_model_handle = 'https://tfhub.dev/google/yamnet/1' # YAMNet 모델 URL
try:
    yamnet_model = hub.load(yamnet_model_handle)
    print("YAMNet 모델 로드 완료.")
except Exception as e:
    
    print(f"YAMNet 모델 로드 중 오류 발생: {e}")
    print("인터넷 연결을 확인하거나 TensorFlow Hub 접근에 문제가 없는지 확인해주세요.")
    sys.exit(1) # 모델 로드 실패 시 프로그램 종료

# YAMNet 클래스 이름 로드 - 오류 수정된 csv 모듈 방식 사용
class_map_path = yamnet_model.class_map_path().numpy().decode('utf-8')
class_names = []
try:
    with open(class_map_path, 'r', encoding='utf-8') as csvfile:
        reader = csv.reader(csvfile)
        next(reader) # 헤더 건너뛰기 ('index,mid,display_name' 형식)
        
        for row in reader:
            if len(row) > 2: # 최소 3개의 열이 있는지 확인 (index, mid, display_name)
                class_names.append(row[2]) # display_name은 세 번째 열 (인덱스 2)
    print(f"YAMNet 클래스 {len(class_names)}개 로드 완료.")
except Exception as e:
    print(f"YAMNet 클래스 맵 파일을 로드하는 중 오류 발생: {e}")
    print("YAMNet 모델 파일 내부에 클래스 맵이 손상되었을 수 있습니다.")
    sys.exit(1) # 클래스 로드 실패 시 프로그램 종료


# --- 2. 특정 위험 소리 클래스 정의 및 임계값 설정 ---
# YAMNet의 521개 클래스 중에서 우리가 관심 있는 위험 소리들을 정의합니다.
# 이 리스트는 YAMNet의 실제 클래스 이름과 정확히 일치해야 합니다.
DANGEROUS_SOUND_CLASSES = [
    'Vehicle',                   # 차량 전반
    'Car',                       # 승용차
    'Motor vehicle (road)',      # 자동차 (도로)
    'Traffic noise, roadway noise', # 교통 소음, 도로 소음
    'Horn',                      # 뿔 (경적의 일종)
    'Car horn, automobile horn', # 자동차 경적, 자동차 뿔 (가장 중요)
    'Vehicle horn, car horn, honking', # 차량 경적, 자동차 경적, 빵빵거림 (가장 중요)
    'Emergency vehicle',         # 응급 차량
    'Police car (siren)',        # 경찰차 (사이렌)
    'Ambulance (siren)',         # 구급차 (사이렌)
    'Fire engine, fire truck (siren)', # 소방차 (사이렌)
    'Siren',                     # 사이렌 (가장 중요)
    'Bicycle bell',              # 자전거 벨 (잠재적 위험 소리)
    'Brake squeal',              # 브레이크 삐걱거림 (잠재적 위험 소리)
    'Skidding',                  # 미끄러짐
    'Explosion',                 # 폭발 (극단적 위험)
    'Engine knocking',           # 엔진 노킹 (차량 소음의 일종)
]

# 위험 소리 감지 임계값 (0.0 ~ 1.0 사이 값, 높을수록 엄격)
# 이 값은 실제 테스트를 통해 조절해야 합니다. (0.5에서 시작하여 필요시 낮춰보세요)
DANGER_THRESHOLD = 0.1 # 예시 값

# --- 3. 실시간 오디오 스트림 설정 ---
# YAMNet이 요구하는 샘플링 레이트
TARGET_SAMPLERATE = 16000 # Hz
# YAMNet의 내부 처리 단위와 유사하게 0.975초 (1초 미만) 오디오 청크를 사용
# YAMNet은 0.975초마다 임베딩과 스코어를 생성합니다.
CHUNK_DURATION_SEC = 0.975 # YAMNet의 내부 프레임 시간과 유사
CHUNK_SIZE = int(TARGET_SAMPLERATE * CHUNK_DURATION_SEC)
INPUT_CHANNELS = 1 # 모노 마이크 입력

# 콜백 함수에서 데이터를 처리할 큐 (thread-safe 큐를 사용하는 것이 더 좋지만, 간단한 예시에서는 리스트 사용)
audio_q = []

def callback(indata, frames, time_info, status):
    """sounddevice 스트림으로부터 오디오 데이터를 받을 때마다 호출되는 콜백 함수."""
    if status:
        print(f"오디오 스트림 상태 경고: {status}", file=sys.stderr)
    audio_q.append(indata.copy()) # 수신된 오디오 데이터를 큐에 추가

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
        print("경고: YAMNet 클래스 이름이 로드되지 않아 특정 소리 분류를 건너뜝니다.", file=sys.stderr)
        return False, []

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
        if i >= len(mean_scores): # IndexError 방지 (클래스 이름이 스코어보다 많을 경우)
            continue 

        if class_name in DANGEROUS_SOUND_CLASSES:
            score = mean_scores[i]
            if score >= DANGER_THRESHOLD:
                detected_dangerous_events.append({'class': class_name, 'score': score})
                is_danger_detected = True
    
    return is_danger_detected, detected_dangerous_events

if __name__ == "__main__":
    print("\n마이크 실시간 감지를 시작합니다. 중지하려면 Ctrl+C를 누르세요.")
    
    try:
        # sounddevice를 사용하여 오디오 스트림 열기
        # 콜백 함수는 별도의 스레드에서 실행되므로, 메인 루프는 비동기적으로 큐를 확인
        with sd.InputStream(samplerate=TARGET_SAMPLERATE, channels=INPUT_CHANNELS, dtype='float32', callback=callback) as stream:
            print(f"마이크 입력 스트림 시작: {stream.samplerate} Hz, {stream.channels} 채널, {stream.dtype} 타입")
            
            audio_buffer = np.zeros(0, dtype=np.float32) # 오디오 청크를 위한 버퍼
            
            # 무한 루프: 마이크로부터 지속적으로 데이터를 받아 분석
            while True:
                if audio_q: # 큐에 새로운 데이터가 있다면
                    chunk = audio_q.pop(0).flatten() # 큐에서 데이터 꺼내고 1차원 배열로 평탄화
                    audio_buffer = np.concatenate((audio_buffer, chunk)) # 버퍼에 추가

                    # 버퍼의 길이가 YAMNet 처리 단위 이상이 되면 분석 수행
                    while len(audio_buffer) >= CHUNK_SIZE:
                        process_chunk = audio_buffer[:CHUNK_SIZE]
                        audio_buffer = audio_buffer[CHUNK_SIZE:] # 처리한 만큼 버퍼에서 제거

                        # 현재 처리 중인 오디오 청크의 대략적인 시간 표시
                        # 이 시간은 스트림이 시작된 시점부터의 상대적인 시간입니다.
                        current_time_offset = stream.time - (len(audio_buffer) + len(process_chunk)) / TARGET_SAMPLERATE
                        print(f"\n--- 오디오 처리 중 (시작 + {current_time_offset:.2f}초) ---")

                        is_danger, detected_events = detect_dangerous_sounds(process_chunk)

                        if is_danger:
                            print("!!! 위험 소리 감지 !!!")
                            for event in detected_events:
                                print(f"  - {event['class']}: {event['score']:.4f} (임계값 {DANGER_THRESHOLD})")
                        else:
                            print("위험 소리 감지되지 않음.")
                else:
                    # 큐에 데이터가 없으면 잠시 대기 (CPU 과부하 방지)
                    time.sleep(0.001)

    except KeyboardInterrupt:
        print("\n[알림] 사용자가 프로그램을 종료했습니다.")
    except sd.PortAudioError as e:
        print(f"\n[오류] PortAudio 오류가 발생했습니다. 마이크 장치를 확인해주세요: {e}", file=sys.stderr)
        print("마이크가 컴퓨터에 연결되어 있고, 드라이버가 설치되어 있는지 확인하세요.", file=sys.stderr)
        print("sudo apt-get install libportaudio2 (라즈베리파이/리눅스) 또는 PortAudio 드라이버를 설치해보세요.", file=sys.stderr)
    except Exception as e:
        print(f"\n[오류] 예상치 못한 오류가 발생했습니다: {e}", file=sys.stderr)
        print("마이크 권한, 필요한 라이브러리 설치 상태 등을 확인해주세요.", file=sys.stderr)