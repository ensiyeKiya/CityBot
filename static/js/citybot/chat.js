/* ========================= 3. Chat helpers ======================== */
    const chatMessages      = document.getElementById('chatMessages');
    const messageInput      = document.getElementById('messageInput');
    const sendButton        = document.getElementById('sendButton');
    const chatForm          = document.getElementById('chatForm');
    const micButton         = document.getElementById('micButton');
    const chatPanel         = document.getElementById('chatPanel');


    /* ========================= 3.1 Chat Panel Dragging ======================== */
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    // Initialize drag functionality
    function initChatPanelDrag() {
      const chatHeader = chatPanel.querySelector('.chat-header');
      
      chatHeader.addEventListener('mousedown', (e) => {
        // Don't start drag if clicking on input elements
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA') {
          return;
        }
        
        isDragging = true;
        chatPanel.classList.add('dragging');
        
        const rect = chatPanel.getBoundingClientRect();
        dragOffset.x = e.clientX - rect.left;
        dragOffset.y = e.clientY - rect.top;
        
        e.preventDefault();
      });

      // Add drag functionality to the entire panel when minimized
      chatPanel.addEventListener('mousedown', (e) => {
        // Only handle drag on minimized panel, and not on buttons
        if (!chatPanel.classList.contains('minimized')) {
          return;
        }
        
        // Don't start drag if clicking on buttons
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) {
          return;
        }
        
        isDragging = true;
        chatPanel.classList.add('dragging');
        
        const rect = chatPanel.getBoundingClientRect();
        dragOffset.x = e.clientX - rect.left;
        dragOffset.y = e.clientY - rect.top;
        
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        const x = e.clientX - dragOffset.x;
        const y = e.clientY - dragOffset.y;
        
        // Keep panel within viewport bounds
        const maxX = window.innerWidth - chatPanel.offsetWidth;
        const maxY = window.innerHeight - chatPanel.offsetHeight;
        
        const constrainedX = Math.max(0, Math.min(x, maxX));
        const constrainedY = Math.max(0, Math.min(y, maxY));
        
        chatPanel.style.left = constrainedX + 'px';
        chatPanel.style.top = constrainedY + 'px';
        chatPanel.style.right = 'auto';
        chatPanel.style.bottom = 'auto';
      });

      document.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          chatPanel.classList.remove('dragging');
        }
      });

      // Prevent text selection while dragging
      chatHeader.addEventListener('selectstart', (e) => {
        e.preventDefault();
      });
    }

    // Initialize drag functionality when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initChatPanelDrag);
    } else {
      initChatPanelDrag();
    }

    /* ========================= 3.15 Chat Panel Resize (top edge) ======================== */
    function initChatPanelResize() {
      const resizeHandle = document.getElementById('resizeHandleTop');
      if (!resizeHandle) return;

      const MIN_HEIGHT = 300;
      let isResizing   = false;
      let startY       = 0;
      let startHeight  = 0;
      let startTop     = 0;  // panel top in viewport px at resize start

      resizeHandle.addEventListener('mousedown', (e) => {
        if (chatPanel.classList.contains('minimized')) return;
        e.preventDefault();
        e.stopPropagation();

        // Capture current geometry in viewport coordinates
        const rect  = chatPanel.getBoundingClientRect();
        startY      = e.clientY;
        startHeight = rect.height;
        startTop    = rect.top;

        // Switch to absolute top+left positioning so we can move the top edge freely
        // (panel may still be using bottom/right from its initial CSS)
        chatPanel.style.top    = startTop + 'px';
        chatPanel.style.left   = rect.left + 'px';
        chatPanel.style.right  = 'auto';
        chatPanel.style.bottom = 'auto';

        isResizing = true;
        chatPanel.classList.add('resizing');
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        // Bottom edge stays fixed; only the top moves
        const panelBottom = startTop + startHeight;

        // New top follows the cursor, clamped so the panel never leaves the viewport
        // and never gets shorter than MIN_HEIGHT
        const rawTop     = startTop + (e.clientY - startY);
        const maxTop     = panelBottom - MIN_HEIGHT;   // keep at least MIN_HEIGHT
        const newTop     = Math.max(0, Math.min(rawTop, maxTop));
        const newHeight  = panelBottom - newTop;

        chatPanel.style.top    = newTop    + 'px';
        chatPanel.style.height = newHeight + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          chatPanel.classList.remove('resizing');
        }
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initChatPanelResize);
    } else {
      initChatPanelResize();
    }

    /* ========================= 3.2 Chat Panel Minimize/Maximize ======================== */
    function initChatPanelMinimize() {
      const chatPanel = document.getElementById('chatPanel');
      const minimizeBtn = document.getElementById('minimizeBtn');
      const maximizeBtn = document.getElementById('maximizeBtn');
      
      if (!chatPanel || !minimizeBtn || !maximizeBtn) {
        console.error('Chat panel or buttons not found');
        return;
      }
      
      let isMinimized = false;
      
      minimizeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering drag
        
        isMinimized = true;
        chatPanel.classList.add('minimized');      });

      maximizeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering drag
        
        isMinimized = false;
        chatPanel.classList.remove('minimized');      });
    }

    // Initialize minimize functionality when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initChatPanelMinimize);
    } else {
      initChatPanelMinimize();
    }

    let state = 'IDLE'; // can be: IDLE, LISTENING, PROCESSING, SPEAKING
    let mediaRecorder, audioChunks = [];
    let audioCtx, analyser, sourceNode, silenceTimer;
    let stream;
    let currentAudio = null;
    let inactivityTimeout = null;
    let isqamode = true; // Always QA mode
    let myvad;
    let lastSpeachSilanceState = null;
    
    // Performance timing storage
    const performanceMetrics = {
      recordingStart: null,
      recordingEnd: null,
      sttStart: null,
      sttEnd: null,
      llmStart: null,
      llmEnd: null,
      ttsStart: null,
      ttsEnd: null,
      totalStart: null,
      totalEnd: null
    };

// === Toggle talking mode ===
    micButton.addEventListener('click', async () => {
      if (state === 'IDLE') {
        messageInput.value = '';
        messageInput.disabled = true;
        sendButton.disabled = true;
        micButton.classList.replace('red', 'green');
        // Add recording class to chat panel for minimized state styling
        chatPanel.classList.add('recording');
        await startListeningMode()
      } else if (state === 'LISTENING') {
        // When button is green (recording), process current audio and continue conversation
        stopRecordingAndProcess(false);
      } else {
        // For other states (SPEAKING, PROCESSING), stop listening mode
        micButton.classList.replace('green', 'red');
        // Remove recording class from chat panel
        chatPanel.classList.remove('recording');
        stopListeningMode();
      }
    });
    
    // === Listening Mode Start ===
    async function startListeningMode({ interruptionMode = false} = {}) {
      try {
        // Request high-quality audio with echo cancellation and noise suppression
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,  // Automatically adjust microphone gain
            sampleRate: 48000       // Higher sample rate for better quality
          } 
        });        state = 'LISTENING';
        audioCtx = new AudioContext();
        sourceNode = audioCtx.createMediaStreamSource(stream);
        
        // Add a gain node to boost audio if needed
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 1.5;  // Boost audio by 50%
        
        analyser = audioCtx.createAnalyser();
        sourceNode.connect(gainNode);
        gainNode.connect(analyser);
    
        // Configure MediaRecorder with optimal audio quality
        const options = {
          mimeType: 'audio/webm;codecs=opus',
          audioBitsPerSecond: 128000  // 128 kbps for clear speech
        };
        
        // Fallback for browsers that don't support the preferred format
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options.mimeType = 'audio/webm';
        }
        
        mediaRecorder = new MediaRecorder(stream, options);
        audioChunks = [];
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    
        mediaRecorder.onstart = () => {
          performanceMetrics.recordingStart = performance.now();
          if(!interruptionMode){          } else{          }
            initVAD();
        };
    
        mediaRecorder.start();

        // QA mode - no inactivity timeout needed
      } catch (err) {
        console.error("❌ Microphone error:", err);
        alert("Microphone access failed: " + err.message);
        unlockUI();
      }
    }

    async function initVAD(){
      myvad = await vad.MicVAD.new({
        stream: mediaRecorder.stream,
        // Improved VAD sensitivity configuration
        positiveSpeechThreshold: 0.6,    // Lower = more sensitive (default: 0.5)
        negativeSpeechThreshold: 0.35,   // Lower = detects speech end faster (default: 0.5)
        redemptionFrames: 8,              // Frames to wait before declaring speech end (default: 8)
        preSpeechPadFrames: 20,          // Capture 20 frames (~600ms) BEFORE speech starts - prevents cutting off first words!
        minSpeechFrames: 3,              // Minimum frames to consider as speech (default: 3)
        submitUserSpeechOnPause: true,   // Auto-submit when pause detected
        onSpeechStart: () => {        },
        onSpeechEnd: async (audioSegment) => {          if (state === 'LISTENING') {
            stopRecordingAndProcess(true);
          }
        },
        onFrameProcessed: (probs, frame) => {
          if (!probs) return;

          // Decide current state
          const currentSpeachSilanceState = probs.isSpeech > probs.notSpeech ? "speech" : "silence";

          // Print only if state changed
          if (currentSpeachSilanceState !== lastSpeachSilanceState) {            lastSpeachSilanceState = currentSpeachSilanceState;
          }
        }
      });
      myvad.start();
    }

    // === Silence Detection ===
    function detectSilence({
      volumeThreshold = 0.04,   // Minimum RMS to be considered voice
      silenceDelay = 1500,       // ms of silence before stopping
      minSpeakingTime = 300,     // Must speak this long to count as speech
      speechGapTolerance = 1200,   // Allow brief pauses in speech without resetting
    } = {}) {
      const bufferLength = analyser.fftSize;
      const dataArray = new Uint8Array(bufferLength);
      let silenceStart = null;
      let speakingStart = null;
      let wasSpeaking = false;
      let inSpeechSession = false; // Track if we're in an active speech session
    
      const checkSilence = () => {
        analyser.getByteTimeDomainData(dataArray);
    
        const rms = Math.sqrt(dataArray.reduce((sum, val) => {
          const norm = (val - 128) / 128;
          return sum + norm * norm;
        }, 0) / bufferLength);
    
        const now = Date.now();
    
        if (rms > volumeThreshold) {
          // Voice detected
          if (!wasSpeaking) {
            clearTimeout(inactivityTimeout);
            if (!inSpeechSession) {
              speakingStart = now;            }
            wasSpeaking = true;
            silenceStart = null;
            
            // Clear any pending silence timeout
            if (silenceTimer) {
              clearTimeout(silenceTimer);
              silenceTimer = null;
            }
            // Handle interruption IMMEDIATELY when voice is detected during bot speech
            if (!isqamode && currentAudio) {              interruptTTS();
            }
          }
    
          // Check if we've been speaking long enough to consider this valid speech
          if (speakingStart && now - speakingStart > minSpeakingTime && !inSpeechSession) {
            inSpeechSession = true;
          }
        } else {
          // Silence detected
          if (wasSpeaking) {
            if (silenceStart === null) {
              silenceStart = now;
            }
            
            // Only reset wasSpeaking after speech gap tolerance
            if (now - silenceStart > speechGapTolerance) {
              wasSpeaking = false;
            }
          }
    
          // Set timeout to stop recording only if we're in a speech session
          // and haven't set a timer yet
          if (inSpeechSession && silenceStart && !silenceTimer) {
            silenceTimer = setTimeout(() => {
              if (state === 'LISTENING') {                stopRecordingAndProcess(true);
              }
            }, silenceDelay);
          }
        }
    
        if (state === 'LISTENING') {
          requestAnimationFrame(checkSilence);
        }
      };
    
      checkSilence();
    }
    
    // === Stop + Process Recording ===
    function stopRecordingAndProcess(interruptionMode = false) {
      if (state !== 'LISTENING') {        unlockUI();
        return;
      }

      // Check if mediaRecorder is still active
      if (!mediaRecorder || mediaRecorder.state !== 'recording') {        unlockUI();
        return;
      }

      if (myvad) {
        try {
          myvad.pause();        } catch (err) {
          console.error("⚠️ Error pausing VAD in stopRecordingAndProcess:", err);
        }
      }

      if (inactivityTimeout){
        clearTimeout(inactivityTimeout);
        inactivityTimeout = null
      }
    
      performanceMetrics.recordingEnd = performance.now();
      performanceMetrics.totalStart = performanceMetrics.recordingStart; // Total starts from recording
    
      // Calculate recording duration
      const recordingDuration = performanceMetrics.recordingEnd - performanceMetrics.recordingStart;      logTiming('🎙️ Recording Duration', performanceMetrics.recordingStart, performanceMetrics.recordingEnd);
    
      // Minimum recording duration check (500ms) - prevents accidental clicks
      const MIN_RECORDING_DURATION = 500; // milliseconds
      if (recordingDuration < MIN_RECORDING_DURATION) {        mediaRecorder.stop();
        state = 'IDLE';
        unlockUI();
        return;
      }
    
      mediaRecorder.stop();
      state = 'PROCESSING';
    
      mediaRecorder.onstop = async () => {
   
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        
        const audioBuffer = await audioBlob.arrayBuffer();
        
        // Validate audioBuffer before passing to transcribeAudio
        if (!audioBuffer || audioBuffer.byteLength === 0) {
          unlockUI();
          return;
        }
        
        if (audioBuffer.byteLength > 25 * 1024 * 1024) { // 25MB limit
          unlockUI();
          return;
        }
    
        try {
          const text = await transcribeAudio(audioBuffer);
          await handleUserTextStream(text);
        } catch (err) {
          console.error("🔥 Processing error:", err);
          console.error(" Processing error stack:", err.stack);
          unlockUI();
        }
        
        // QA mode - no continuous listening
      };
    }

    async function handleUserText(text, useTTS = true) {
      if (!text.trim()){
        unlockUI();
        return;
      }

      addMessage(text, true);

      const thinking = addMessage('Thinking…', false, true);

      try {
        const userId = requireLoggedInUserId();
        
        const result = await llmThing.invokeAction('processConversation', {
          message: text,
          userId,
          sessionId: window.chatSessionId,
          ...getLlmContextPayload()
        });
        const actionResult = typeof result.value === 'function' ? await result.value() : result;
        
        thinking.remove();
        
        if (actionResult.error) {
          addMessage(`Error: ${actionResult.message}`);
        } else {
          // Display the response directly without streaming simulation
          addMessage(actionResult.response || 'Action completed successfully!', false);
          
          // Create a container for system messages
          const sysContainer = document.createElement('div');
          sysContainer.style.marginBottom = '12px';
          
          // Show additional info if available
          if (actionResult.toolsUsed && actionResult.toolsUsed.length > 0) {
            const toolsMsg = document.createElement('div');
            toolsMsg.className = 'message system-message';
            toolsMsg.innerHTML = `<strong>Tools:</strong> ${actionResult.toolsUsed.join(', ')}`;
            sysContainer.appendChild(toolsMsg);
          }
          
          if (actionResult.processingTime) {
            const timeMsg = document.createElement('div');
            timeMsg.className = 'message system-message';
            // Convert milliseconds to seconds with 2 decimal places
            const seconds = (actionResult.processingTime / 1000).toFixed(2);
            timeMsg.innerHTML = `<strong>Processing time:</strong> ${seconds} seconds`;
            sysContainer.appendChild(timeMsg);
          }
          
          if (sysContainer.childNodes.length > 0) {
            chatMessages.appendChild(sysContainer);
          }
          
          // Ensure scroll to bottom
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        if (useTTS) { // Only do TTS if useTTS is true
          const audio = await getSpeech(actionResult.response);
          const audioURL = URL.createObjectURL(audio);
          currentAudio = new Audio(audioURL);
    
          currentAudio.onended = () => {
            performanceMetrics.totalEnd = performance.now();            currentAudio = null;
            stopListeningMode();
          };
    
          try {
            await currentAudio.play();
            state = 'SPEAKING';
          } catch (err) {
            console.error("🔇 Audio playback error:", err);
            unlockUI();
          }
        }
        
      } catch (err) {
        thinking.remove();
        console.error('WoT action error:', err);
        addMessage(`Error: ${err.message}`);
        unlockUI();
      }
    }

    // === LLM + TTS ===
    async function handleUserTextStream(text, useTTS = true) {
      if (!text.trim()){
        unlockUI();
        return;
      }

      addMessage(text, true);

      const thinking = addMessage('🧠 Planning...', false, true);

      try {
        const userId = requireLoggedInUserId();

        // Clear previous stream UI state
        window.activeStreamRequestId = null;
        window.streamMessageContentEl = null;

        const result = await window.llmThing.invokeAction('processConversationStream', { 
          message: text,
          userId,
          sessionId: window.chatSessionId,
          ...getLlmContextPayload()
        });
        const actionResult = typeof result.value === 'function' ? await result.value() : result;

        if (!actionResult.started) {
          thinking.remove();
          throw new Error(actionResult.error || 'Failed to start streaming');
        }

        // Bind the request id as soon as we get it
        window.activeStreamRequestId = actionResult.requestId;
        
        // Set flag for TTS handling after streaming completes
        if (useTTS) {
          window.shouldDoTTSAfterStream = true;
        } else {
          window.shouldDoTTSAfterStream = false;
        }
        
      } catch (err) {
        console.error('WoT action error:', err);
        addMessage(`Error: ${err.message}`);
        unlockUI();
      }
    }
    
    function interruptTTS() {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0; // Reset playback position
        currentAudio.src = "";
        currentAudio.load(); // Force reload
        currentAudio = null;      }
    }
    
    // === Manual stop ===
    function stopListeningMode() {      state = 'IDLE';
      
      if (inactivityTimeout) {
        clearTimeout(inactivityTimeout);
        inactivityTimeout = null;
      }
      
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      // Stop VAD to prevent callbacks after manual stop
      if (myvad) {
        try {
          myvad.pause();        } catch (err) {
          console.error("⚠️ Error pausing VAD:", err);
        }
      }

      if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();
        // Prevent the onstop handler from processing the audio
        mediaRecorder.onstop = null;
      }

      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }

      if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
      }

      // Remove recording class from chat panel
      chatPanel.classList.remove('recording');
      
      unlockUI();
      interruptTTS();
    }
    
    async function transcribeAudio(audioBuffer) {
      // Add call stack tracking to detect infinite recursion
      if (!window.transcribeAudioCallCount) {
        window.transcribeAudioCallCount = 0;
      }
      window.transcribeAudioCallCount++;

      // Check for potential infinite recursion
      if (window.transcribeAudioCallCount > 5) {
        console.error(`🚨 CRITICAL: transcribeAudio called ${window.transcribeAudioCallCount} times - potential infinite recursion!`);
        window.transcribeAudioCallCount = 0; // Reset counter
        throw new Error('Maximum transcribeAudio call limit exceeded - infinite recursion detected');
      }
      
      // Reset counter after a delay to allow for legitimate retries
      setTimeout(() => {
        if (window.transcribeAudioCallCount > 0) {          window.transcribeAudioCallCount = 0;
        }
      }, 5000);
      
      performanceMetrics.sttStart = performance.now();
      
      try {
        
        // Check if audioBuffer is valid before processing
        if (!audioBuffer || !(audioBuffer instanceof ArrayBuffer) || audioBuffer.byteLength === 0) {
          throw new Error(`Invalid audioBuffer: type=${typeof audioBuffer}, byteLength=${audioBuffer?.byteLength || 'N/A'}`);
        }
        
        // Convert audio buffer to base64 - optimized approach
        let base64Audio;
        try {
          const uint8Array = new Uint8Array(audioBuffer);          
          // Use optimized chunked conversion for all sizes to prevent memory issues
          const chunks = [];
          const chunkSize = 32768; // 32KB chunks for optimal performance
          
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
            chunks.push(String.fromCharCode(...chunk));
          }
          base64Audio = btoa(chunks.join(''));        } catch (base64Error) {
          console.error('❌ Base64 conversion error:', base64Error);
          throw new Error(`Base64 conversion failed: ${base64Error.message}`);
        }        
        // Show visual feedback for transcription
        messageInput.placeholder = "🎤 Transcribing audio...";
        
        // Check if llmThing is available
        if (!window.llmThing) {
          messageInput.placeholder = "Type your message here...";
          throw new Error('LLM Thing is not connected');
        }
        
        // Generate a client-side requestId to ensure handler is ready before backend events arrive
        const clientRequestId = `stt-client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Set up the promise and handler BEFORE invoking the action to avoid race condition
        const transcriptionPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {            // Clean up the pending request handler
            if (window.pendingSTTRequests && window.pendingSTTRequests[clientRequestId]) {
              delete window.pendingSTTRequests[clientRequestId];
            }
            reject(new Error('STT transcription timeout'));
          }, 30000); // 30 second timeout
          
          // Store the request handler in a global registry for the existing subscription to use
          if (!window.pendingSTTRequests) {
            window.pendingSTTRequests = {};
          }          
          window.pendingSTTRequests[clientRequestId] = {
            resolve: (text) => {
                clearTimeout(timeout);
                performanceMetrics.sttEnd = performance.now();
                logTiming('🧠 STT Processing', performanceMetrics.sttStart, performanceMetrics.sttEnd);              messageInput.placeholder = "Type your message here..."; // Reset placeholder
              window.transcribeAudioCallCount--; // Decrement on successful completion
              delete window.pendingSTTRequests[clientRequestId];
              resolve(text || "(Could not transcribe)");
            },
            reject: (error) => {
                clearTimeout(timeout);
                performanceMetrics.sttEnd = performance.now();
                logTiming('🧠 STT Error', performanceMetrics.sttStart, performanceMetrics.sttEnd);
              console.error("🧾 Transcription error:", error);
              messageInput.placeholder = "Type your message here..."; // Reset placeholder
              window.transcribeAudioCallCount--; // Decrement on error
              delete window.pendingSTTRequests[clientRequestId];
              reject(new Error(error || 'STT transcription failed'));
            }
          };
        });
        
        // Now invoke the action - handler is already registered
        const result = await window.llmThing.invokeAction('transcribeAudio', {
          audio: base64Audio,
          language: 'en',
          task: 'transcribe',
          suppressNonSpeechTokens: true,
          clientRequestId: clientRequestId,  // Pass our client-side requestId to backend
          userId: window.currentUserId        // Scope STT progress events to this user
        });  
        
        const actionResult = typeof result.value === 'function' ? await result.value() : result;
        
        if (!actionResult.started) {
          // Clean up handler if action failed to start
          delete window.pendingSTTRequests[clientRequestId];
          throw new Error(actionResult.message || 'Failed to start transcription');
        }
        // Wait for transcription completion via event
        return transcriptionPromise;
        
      } catch (error) {
        console.error(` transcribeAudio caught error:`, error);
        console.error(` Error stack:`, error.stack);
        performanceMetrics.sttEnd = performance.now();
        logTiming('🧠 STT Error', performanceMetrics.sttStart, performanceMetrics.sttEnd);
        console.error("STT Error:", error);
        window.transcribeAudioCallCount--; // Decrement on error
        throw error;
      }
    }

    async function getSpeech(text) {
      performanceMetrics.ttsStart = performance.now();
      
      try {
        // Check if llmThing is available
        if (!window.llmThing) {
          throw new Error('LLM Thing is not connected');
        }        
        // Use WoT action instead of REST endpoint
        const preferredVoice = localStorage.getItem('tts_voice') || 'af_sky';
        const preferredLang = localStorage.getItem('tts_language') || 'en';        
        const result = await window.llmThing.invokeAction('textToSpeech', { 
          text: text,
          language: preferredLang,
          voice: preferredVoice
        });

        performanceMetrics.ttsEnd = performance.now();
        logTiming('🔊 TTS Generation', performanceMetrics.ttsStart, performanceMetrics.ttsEnd);        
        // CRITICAL: WoT actions should ALWAYS be accessed via result.value()
        // Do NOT access result.data directly as it locks the stream before we can read it
        let actualResult;
        
        if (result.value && typeof result.value === 'function') {          try {
            actualResult = await result.value();          } catch (err) {
            console.error('🔊 DEBUG FRONTEND: result.value() failed:', err);
            throw new Error('Unable to read TTS data from WoT action: ' + err.message);
          }
        } else {
          throw new Error('result.value() is not available - cannot read TTS data');
        }
        if (!actualResult || !actualResult.success) {
          throw new Error(actualResult?.error || 'TTS action failed');
        }

        if (!actualResult.audio) {
          throw new Error('No audio data received from TTS service');
        }

        // Convert base64 audio to blob
        const audioData = atob(actualResult.audio);
        const audioArray = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
          audioArray[i] = audioData.charCodeAt(i);
        }
        
        const blob = new Blob([audioArray], { type: 'audio/wav' });        return blob;

      } catch (error) {
        performanceMetrics.ttsEnd = performance.now();
        logTiming('🔊 TTS Error', performanceMetrics.ttsStart, performanceMetrics.ttsEnd);
        console.error('❌ TTS error:', error);
        throw error;
      }
    }

    function unlockUI() {
      // Reset mic button
      micButton.classList.replace('green', 'red');
      state = 'IDLE';

      // Remove recording class from chat panel
      chatPanel.classList.remove('recording');

      // Unlock UI elements
      messageInput.disabled = false;
      sendButton.disabled = false;
      micButton.disabled = false;
    }

    // Utility function to log timing
    function logTiming(label, startTime, endTime) {
      const duration = endTime - startTime;      return duration;
    }

    // Simple markdown to HTML converter
    function markdownToHtml(text) {
      return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold **text**
        .replace(/\*(.*?)\*/g, '<em>$1</em>') // Italic *text*
        .replace(/\n\n/g, '<br><br>') // Double line breaks
        .replace(/\n/g, '<br>') // Single line breaks
        .replace(/^### (.*$)/gim, '<h3>$1</h3>') // H3 headers
        .replace(/^## (.*$)/gim, '<h2>$1</h2>') // H2 headers
        .replace(/^# (.*$)/gim, '<h1>$1</h1>') // H1 headers
        .replace(/- (.*)/g, '• $1'); // Bullet points
    }

    // Sanitize text for TTS - remove markdown formatting, emojis, and special characters
    function sanitizeTextForTTS(text) {
      if (!text) return '';
      
      return text
        // Remove Bulgarian text in parentheses (Cyrillic characters)
        .replace(/\([^()]*[\u0400-\u04FF\u0500-\u052F][^()]*\)/g, '') // Remove (Bulgarian text)
        
        // Remove markdown formatting
        .replace(/\*\*(.*?)\*\*/g, '$1') // Bold **text** -> text
        .replace(/\*(.*?)\*/g, '$1') // Italic *text* -> text
        .replace(/__(.*?)__/g, '$1') // Bold __text__ -> text
        .replace(/_(.*?)_/g, '$1') // Italic _text_ -> text
        .replace(/~~(.*?)~~/g, '$1') // Strikethrough ~~text~~ -> text
        .replace(/`([^`]+)`/g, '$1') // Inline code `text` -> text
        .replace(/```[\s\S]*?```/g, '') // Code blocks -> remove
        .replace(/#{1,6}\s+/g, '') // Headers # -> remove
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links [text](url) -> text
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // Images ![alt](url) -> alt
        .replace(/^\s*[-*+]\s+/gm, '') // List markers -> remove
        .replace(/^\s*\d+\.\s+/gm, '') // Numbered list markers -> remove
        .replace(/^\s*>\s+/gm, '') // Blockquotes -> remove
        .replace(/\|/g, ' ') // Table pipes -> space
        .replace(/[-=]{3,}/g, '') // Horizontal rules -> remove
        
        // Remove emojis (comprehensive emoji regex)
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Emoticons
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Misc Symbols and Pictographs
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Transport and Map
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // Flags
        .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
        .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Supplemental Symbols and Pictographs
        .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '') // Chess Symbols
        .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '') // Symbols and Pictographs Extended-A
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Variation Selectors
        .replace(/[\u{1F200}-\u{1F251}]/gu, '') // Enclosed characters
        
        // Remove other special characters that don't speak well
        .replace(/[•●○◆◇■□▪▫]/g, '') // Bullet points and shapes
        .replace(/[™®©]/g, '') // Trademark symbols
        .replace(/[←→↑↓↔↕]/g, '') // Arrows
        .replace(/[✓✗✕✖]/g, '') // Check marks
        
        // Convert technical units to TTS-friendly words
        .replace(/µg\/m³/gi, 'micrograms per cubic meter') // µg/m³ -> micrograms per cubic meter
        .replace(/kWh\/m²\/year/gi, 'kilowatt-hours per square meter per year') // kWh/m²/year -> kilowatt-hours per square meter per year
        .replace(/km\/h/gi, 'kilometers per hour') // km/h -> kilometers per hour
        .replace(/hPa/gi, 'hectopascals') // hPa -> hectopascals
        .replace(/°C/gi, 'degrees Celsius') // °C -> degrees Celsius
        .replace(/°F/gi, 'degrees Fahrenheit') // °F -> degrees Fahrenheit
        .replace(/m\/s/gi, 'meters per second') // m/s -> meters per second
        .replace(/km\/s/gi, 'kilometers per second') // km/s -> kilometers per second
        .replace(/cm\//gi, 'centimeters per ') // cm/s -> centimeters per second
        .replace(/mm\//gi, 'millimeters per ') // mm/s -> millimeters per second
        .replace(/m²/gi, 'square meters') // m² -> square meters
        .replace(/m³/gi, 'cubic meters') // m³ -> cubic meters
        
        // Clean up whitespace
        .replace(/\n\n+/g, '. ') // Multiple newlines -> period and space
        .replace(/\n/g, '. ') // Single newlines -> period and space
        .replace(/\s+/g, ' ') // Multiple spaces -> single space
        .replace(/\.\s*\./g, '.') // Multiple periods -> single period
        .replace(/\s+\./g, '.') // Space before period -> just period
        .trim();
    }

    // Add global function to check stream statistics
    window.checkStreamStats = () => {
      if (window.conversationStreamStats) {
        return window.conversationStreamStats;
      }
      return null;
    };

    // Make addMessage globally available
    window.addMessage = (text, isUser = false, isThinking = false) => {
      const div = document.createElement('div');
      div.className = `message ${isUser ? 'user-message' : 'bot-message'}${isThinking ? ' thinking' : ''}`;
      
      // Create message content
      const messageContent = document.createElement('div');
      messageContent.className = 'message-content';
      // Use innerHTML for bot messages to render formatting, textContent for user messages for security
      if (isUser) {
        messageContent.textContent = text;
      } else {
        messageContent.innerHTML = markdownToHtml(text);
      }
      div.appendChild(messageContent);
      
      // Add timestamp (except for thinking messages)
      if (!isThinking) {
        const timestamp = document.createElement('div');
        timestamp.className = 'message-time';
        const now = new Date();
        timestamp.textContent = now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        div.appendChild(timestamp);
      }
      
      // Remove any existing thinking messages when adding a non-thinking message
      if (!isThinking) {
        document.querySelectorAll('.thinking').forEach(thinkingMsg => {
          thinkingMsg.remove();
        });
      }
      
      chatMessages.appendChild(div);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return div;
    };

    async function sendMessageStream () {
      const txt = messageInput.value.trim();
      if (!txt) return;

      addMessage(txt, true);
      messageInput.value = '';
      messageInput.disabled = true;
      sendButton.disabled = true;
      micButton.disabled = true;
      presetMenuButton.disabled = true;

      const thinking = addMessage('🧠 Planning...', false, true);

      try {        const userId = requireLoggedInUserId();

        // Clear previous stream UI state
        window.activeStreamRequestId = null;
        window.streamMessageContentEl = null;

        const result = await window.llmThing.invokeAction('processConversationStream', { 
          message: txt,
          userId,
          sessionId: window.chatSessionId,
          ...getLlmContextPayload()
        });
        const actionResult = typeof result.value === 'function' ? await result.value() : result;

        if (!actionResult.started) {
          thinking.remove();
          throw new Error(actionResult.error || 'Failed to start streaming');
        }

        // Bind the request id as soon as we get it
        window.activeStreamRequestId = actionResult.requestId;
        
      } catch (err) {
        thinking.remove();
        console.error('WoT streaming action error:', err);
        addMessage(`Error: ${err.message}`);
      } finally {
        // QA mode - unlock UI immediately
        messageInput.disabled = false;
        sendButton.disabled = false;
        micButton.disabled = false;
        presetMenuButton.disabled = false;
        messageInput.focus();
      }
    }

    /* ——— 3.1 Form submit = single source of truth for "send" ——— */
    chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessageStream();
    });

    /* ——— 3.2 Preset menu functionality ——— */
    const presetMenuButton = document.getElementById('presetMenuButton');
    const presetMenu = document.getElementById('presetMenu');
    const presetQuestionItems = document.querySelectorAll('.preset-question-item');

    const handlePresetMenuToggle = () => {
      if (presetMenuButton.disabled) return;
      presetMenu.classList.toggle('show');
      presetMenuButton.classList.toggle('active');
    };

    const handlePresetQuestionClick = (e) => {
      const question = e.target.getAttribute('data-question');
      if (question) {
        messageInput.value = question;
        messageInput.focus();
        // Place cursor at the end of the text
        messageInput.setSelectionRange(question.length, question.length);
        presetMenu.classList.remove('show');
        presetMenuButton.classList.remove('active');
      }
    };

    // Toggle menu on button click
    presetMenuButton.addEventListener('click', (e) => {
      e.stopPropagation();
      handlePresetMenuToggle();
    });

    // Handle preset question clicks
    presetQuestionItems.forEach(item => {
      item.addEventListener('click', handlePresetQuestionClick);
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!presetMenuButton.contains(e.target) && !presetMenu.contains(e.target)) {
        presetMenu.classList.remove('show');
        presetMenuButton.classList.remove('active');
      }
    });

    // Close menu on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && presetMenu.classList.contains('show')) {
        presetMenu.classList.remove('show');
        presetMenuButton.classList.remove('active');
      }
    });

/* ========================= 8. Feedback Bar =========================== */

    // Feedback type options per sentiment
    const FEEDBACK_TYPES_POSITIVE = [
      { value: 'accurate',   label: '✔ Accurate'     },
      { value: 'helpful',    label: '💡 Helpful'      },
      { value: 'tool_use',   label: '🔧 Good tool use'},
      { value: 'other',      label: '📝 Other'        }
    ];
    const FEEDBACK_TYPES_NEGATIVE = [
      { value: 'accuracy',   label: '❌ Wrong answer'  },
      { value: 'tool_use',   label: '🔧 Wrong tool'    },
      { value: 'relevance',  label: '↔ Off-topic'      },
      { value: 'speed',      label: '⏱ Too slow'       },
      { value: 'other',      label: '📝 Other'         }
    ];

    function buildFeedbackBar(requestId) {
      const wrapper = document.createElement('div');

      // — thumbs row —
      const bar = document.createElement('div');
      bar.className = 'feedback-bar';
      const barLabel = document.createElement('span');
      barLabel.textContent = 'Was this helpful?';
      bar.appendChild(barLabel);

      const thumbUp   = document.createElement('button');
      thumbUp.title   = 'Helpful';
      thumbUp.textContent = '👍';
      const thumbDown = document.createElement('button');
      thumbDown.title = 'Not helpful';
      thumbDown.textContent = '👎';
      bar.appendChild(thumbUp);
      bar.appendChild(thumbDown);
      wrapper.appendChild(bar);

      // — detail form (shown after thumb click) —
      const form = document.createElement('div');
      form.className = 'feedback-form';

      // type selector
      const typeLabel = document.createElement('div');
      typeLabel.className = 'feedback-type-label';
      typeLabel.textContent = 'What best describes it?';
      form.appendChild(typeLabel);

      const typeOptions = document.createElement('div');
      typeOptions.className = 'feedback-type-options';
      form.appendChild(typeOptions);

      // comment
      const textarea = document.createElement('textarea');
      textarea.rows = 2;
      textarea.placeholder = 'Optional comment…';
      form.appendChild(textarea);

      const actions = document.createElement('div');
      actions.className = 'feedback-form-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'feedback-cancel-btn';
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      const submitBtn = document.createElement('button');
      submitBtn.className = 'feedback-submit-btn';
      submitBtn.type = 'button';
      submitBtn.textContent = 'Submit';
      actions.appendChild(cancelBtn);
      actions.appendChild(submitBtn);
      form.appendChild(actions);
      wrapper.appendChild(form);

      let chosenRating = null;

      function buildTypeOptions(types) {
        typeOptions.innerHTML = '';
        types.forEach((t, i) => {
          const lbl = document.createElement('label');
          const radio = document.createElement('input');
          radio.type  = 'radio';
          radio.name  = `fb-type-${requestId}`;
          radio.value = t.value;
          if (i === 0) radio.checked = true; // sensible default
          const span = document.createElement('span');
          span.textContent = t.label;
          lbl.appendChild(radio);
          lbl.appendChild(span);
          typeOptions.appendChild(lbl);
        });
      }

      function openForm(rating) {
        chosenRating = rating;
        buildTypeOptions(rating >= 4 ? FEEDBACK_TYPES_POSITIVE : FEEDBACK_TYPES_NEGATIVE);
        form.classList.add('open');
      }

      async function submitFeedback() {
        const checkedRadio = typeOptions.querySelector('input[type="radio"]:checked');
        const feedbackType = checkedRadio ? checkedRadio.value : (chosenRating >= 4 ? 'helpful' : 'other');
        const comment = textarea.value.trim();
        try {
          await fetch('/api/feedback', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId,
              sessionId: window.chatSessionId,
              rating: chosenRating,
              comment,
              feedbackType
            })
          });
        } catch (e) {
          console.warn('Feedback submit error:', e);
        }
        const thanks = document.createElement('div');
        thanks.className = 'feedback-thanks';
        thanks.textContent = '✅ Thanks for your feedback!';
        wrapper.replaceWith(thanks);
      }

      thumbUp.addEventListener('click', () => {
        thumbUp.classList.add('active');
        thumbDown.classList.remove('active', 'active-neg');
        openForm(5);
      });
      thumbDown.addEventListener('click', () => {
        thumbDown.classList.add('active-neg');
        thumbUp.classList.remove('active');
        openForm(1);
      });
      cancelBtn.addEventListener('click', () => {
        form.classList.remove('open');
        thumbUp.classList.remove('active');
        thumbDown.classList.remove('active-neg');
        chosenRating = null;
      });
      submitBtn.addEventListener('click', submitFeedback);

      return wrapper;
    }

/* ========================= 8. Chat History & New Chat =========================== */

    const historyPanel       = document.getElementById('historyPanel');
    const historySessionList = document.getElementById('historySessionList');
    const historyMessageView = document.getElementById('historyMessageView');
    const historyPanelTitle  = document.getElementById('historyPanelTitle');
    const historyBackBtn     = document.getElementById('historyBackBtn');
    const historyBtn         = document.getElementById('historyBtn');

    function formatRelativeTime(dateStr) {
      const d = new Date(dateStr);
      const now = Date.now();
      const diff = now - d.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1)  return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24)  return `${hrs}h ago`;
      const days = Math.floor(hrs / 24);
      if (days < 7)  return `${days}d ago`;
      return d.toLocaleDateString();
    }

    const chatMessagesEl = document.getElementById('chatMessages');
    const chatInputEl    = document.getElementById('chatInput');

    function showHistoryPanel() {
      chatMessagesEl.style.display = 'none';
      chatInputEl.style.display    = 'none';
      historyPanel.classList.add('open');
    }

    function hideHistoryPanel() {
      historyPanel.classList.remove('open');
      chatMessagesEl.style.display = '';
      chatInputEl.style.display    = '';
    }

    // Open the history panel and show session list
    async function openHistory() {
      historySessionList.style.display = '';
      historyMessageView.style.display = 'none';
      historyPanelTitle.textContent = 'Chat History';
      historyBackBtn.textContent = '✕ Close';
      showHistoryPanel();

      historySessionList.innerHTML = '<div class="history-empty">Loading…</div>';
      try {
        const resp = await fetch('/api/chat/sessions', { credentials: 'include' });
        if (!resp.ok) {
          historySessionList.innerHTML = `<div class="history-empty">Error ${resp.status}: could not load sessions.</div>`;
          return;
        }
        const data = await resp.json();
        if (!data.sessions || !data.sessions.length) {
          historySessionList.innerHTML = '<div class="history-empty">No previous chats yet.</div>';
          return;
        }
        historySessionList.innerHTML = '';
        data.sessions.forEach(s => {
          const item = document.createElement('div');
          item.className = 'session-item';
          const preview = (s.preview || 'Empty chat').substring(0, 80);
          const isCurrent = s.session_id === window.chatSessionId;
          item.innerHTML = `
            <div class="session-item-preview">${isCurrent ? '● ' : ''}${preview}${isCurrent ? ' <em>(current)</em>' : ''}</div>
            <div class="session-item-meta">${formatRelativeTime(s.started_at)} · ${s.message_count} message${s.message_count !== 1 ? 's' : ''}</div>`;
          item.addEventListener('click', () => openSession(s.session_id, preview));
          historySessionList.appendChild(item);
        });
      } catch (e) {
        historySessionList.innerHTML = '<div class="history-empty">Failed to load history.</div>';
        console.error('History fetch error:', e);
      }
    }

    // Show messages for a specific past session
    async function openSession(sessionId, previewText) {
      historySessionList.style.display = 'none';
      historyMessageView.style.display = '';
      historyPanelTitle.textContent = (previewText || 'Session').substring(0, 30) + '…';
      historyBackBtn.textContent = '← Sessions';
      historyMessageView.innerHTML = '<div class="history-empty">Loading…</div>';

      try {
        const resp = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, { credentials: 'include' });
        if (!resp.ok) {
          historyMessageView.innerHTML = `<div class="history-empty">Error ${resp.status}: could not load messages.</div>`;
          return;
        }
        const data = await resp.json();
        if (!data.messages || !data.messages.length) {
          historyMessageView.innerHTML = '<div class="history-empty">No messages in this session.</div>';
          return;
        }
        historyMessageView.innerHTML = '';
        data.messages.forEach(m => {
          const div = document.createElement('div');
          div.className = `message ${m.role === 'user' ? 'user-message' : 'bot-message'}`;
          const safeContent = m.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          div.innerHTML = `<div class="message-content">${safeContent}</div>
                           <div class="message-time">${new Date(m.created_at).toLocaleTimeString()}</div>`;
          historyMessageView.appendChild(div);
        });
        historyMessageView.scrollTop = 0;
      } catch (e) {
        historyMessageView.innerHTML = '<div class="history-empty">Failed to load messages.</div>';
        console.error('Session fetch error:', e);
      }
    }

    // Close / back button inside the history panel
    historyBackBtn.addEventListener('click', () => {
      if (historyMessageView.style.display !== 'none') {
        openHistory();
      } else {
        hideHistoryPanel();
      }
    });

    historyBtn.addEventListener('click', openHistory);
