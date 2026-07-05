'use client';

// Safeguard against window.fetch read-only property issues in sandbox/iframe environments
if (typeof window !== 'undefined') {
  try {
    let currentFetch = window.fetch;
    const desc = {
      get() {
        return currentFetch;
      },
      set(val: any) {
        currentFetch = val;
      },
      configurable: true,
      enumerable: true
    };
    Object.defineProperty(window, 'fetch', desc);
    Object.defineProperty(globalThis, 'fetch', desc);
    Object.defineProperty(self, 'fetch', desc);
  } catch (e) {
    // Gracefully handle environments with strict CSP or non-configurable descriptors
  }
}

import {useState, useEffect, useRef, useCallback} from 'react';
import {motion, AnimatePresence} from 'motion/react';
import {createClient, RealtimeChannel, SupabaseClient} from '@supabase/supabase-js';
import { QRCodeSVG } from 'qrcode.react';
import {
  Upload,
  Download,
  CheckCircle,
  AlertCircle,
  Wifi,
  WifiOff,
  RefreshCw,
  File,
  Shield,
  ArrowRight,
  Sparkles,
  Lock,
  ChevronRight,
  Copy,
  Check,
  Camera,
  CameraOff,
  Plus,
  Instagram
} from 'lucide-react';

// Define transfer metrics state structure
interface TransferStats {
  fileName: string;
  fileSize: number;
  progress: number; // 0 to 100
  transferredBytes: number;
  speed: number; // bytes per second
  remainingTime: number; // seconds
  startTime: number;
}

// Guarded Supabase Client creation to prevent crashes if environment variables are not set
const getSupabaseClient = (): SupabaseClient | null => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
};

export default function Home() {
  // --- STATE VARIABLES ---
  const [status, setStatus] = useState<
    'home' | 'sender-pairing' | 'receiver-pairing' | 'connecting' | 'connected' | 'transferring' | 'complete'
  >('home');
  const [isConnected, setIsConnected] = useState(false);
  const [role, setRoleState] = useState<'sender' | 'receiver' | null>(null);
  const roleRef = useRef<'sender' | 'receiver' | null>(null);
  const setRole = useCallback((newRole: 'sender' | 'receiver' | null) => {
    roleRef.current = newRole;
    setRoleState(newRole);
  }, []);
  const [roomCode, setRoomCode] = useState('');
  const [inputCode, setInputCode] = useState<string[]>(['', '', '', '']);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [stats, setStats] = useState<TransferStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isClient, setIsClient] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [supabaseConfig, setSupabaseConfig] = useState<{ url: string; key: string } | null>(null);
  const [debugLogs, setDebugLogs] = useState<{time: string; text: string; type: 'info' | 'success' | 'warn' | 'error'}[]>([]);
  const [downloadQueue, setDownloadQueue] = useState<{
    id: string;
    name: string;
    size: number;
    type: string;
    chunks: ArrayBuffer[];
    downloaded: boolean;
    receivedBytes: number;
  }[]>([]);

  // --- REFS ---
  const supabaseClientRef = useRef<SupabaseClient | null>(null);
  const html5QrCodeScannerRef = useRef<any>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const fileReaderRef = useRef<FileReader | null>(null);
  const chunksReceivedRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef<number>(0);
  const prevStatsTimeRef = useRef<number>(0);
  const receivedMetadataRef = useRef<{name: string; size: number; type: string} | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const joinRetryIntervalRef = useRef<any>(null);
  const handleSignalMessageRef = useRef<any>(null);
  const statusRef = useRef<string>('home');
  const roomCodeRef = useRef<string>('');
  const joinRoomChannelRef = useRef<any>(null);
  const isSubscribedRef = useRef<boolean>(false);
  const outgoingSignalingQueueRef = useRef<any[]>([]);
  const incomingSignalingQueueRef = useRef<any[]>([]);
  const subscriptionRetryTimeoutRef = useRef<any>(null);
  const inputRefs = [
    useRef<HTMLInputElement | null>(null),
    useRef<HTMLInputElement | null>(null),
    useRef<HTMLInputElement | null>(null),
    useRef<HTMLInputElement | null>(null),
  ];

  // --- DEBUG LOGGER ---
  const addDebugLog = useCallback((text: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
    const time = new Date().toLocaleTimeString();
    console.log(`[DEBUG] [${type.toUpperCase()}] ${text}`);
    setDebugLogs((prev) => [...prev.slice(-99), { time, text, type }]);
  }, []);

  // --- SIGNAL SENDER (QUEUED / RECOVERABLE) ---
  const sendSignalMessage = useCallback((payload: any) => {
    if (isSubscribedRef.current && channelRef.current) {
      addDebugLog(`Broadcasting signal immediately: "${payload?.type}"`, 'info');
      channelRef.current.send({
        type: 'broadcast',
        event: 'signal',
        payload,
      }).catch((err) => {
        console.error('Error sending signal:', err);
        addDebugLog(`Failed to broadcast signal: ${err.message || err}`, 'error');
      });
    } else {
      addDebugLog(`Signaling channel not fully subscribed. Queuing outgoing signal: "${payload?.type}"`, 'warn');
      outgoingSignalingQueueRef.current.push(payload);
    }
  }, [addDebugLog]);

  // --- RUNTIME SUPABASE CONFIGURATION FETCH ---
  useEffect(() => {
    const logTimer = setTimeout(() => {
      addDebugLog('Fetching runtime environment variables from server...', 'info');
    }, 0);

    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        if (data.supabaseUrl && data.supabaseAnonKey) {
          addDebugLog(`Successfully fetched Supabase runtime config. URL: ${data.supabaseUrl}`, 'success');
          setSupabaseConfig({ url: data.supabaseUrl, key: data.supabaseAnonKey });
        } else {
          addDebugLog('Server did not return a valid Supabase runtime config. Checking local environment...', 'warn');
        }
      })
      .catch((err) => {
        addDebugLog(`Failed to fetch runtime config from server: ${err.message || err}`, 'error');
      });

    return () => clearTimeout(logTimer);
  }, [addDebugLog]);

  // --- SUPABASE CLIENT INSTANCE RETRIEVER ---
  const getSupabaseClientInstance = useCallback((): SupabaseClient | null => {
    if (supabaseClientRef.current) {
      return supabaseClientRef.current;
    }
    
    // 1. Try state configuration (fetched from server)
    if (supabaseConfig && supabaseConfig.url && supabaseConfig.key) {
      addDebugLog('Initializing Supabase client using server-side runtime credentials.', 'success');
      supabaseClientRef.current = createClient(supabaseConfig.url, supabaseConfig.key);
      return supabaseClientRef.current;
    }
    
    // 2. Fallback to build-time env vars
    const envUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const envKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (envUrl && envKey) {
      addDebugLog('Initializing Supabase client using build-time environment variables.', 'info');
      supabaseClientRef.current = createClient(envUrl, envKey);
      return supabaseClientRef.current;
    }
    
    return null;
  }, [supabaseConfig, addDebugLog]);

  // Set isClient to true on mount (Next.js SSR safety)
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsClient(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Sync state values to refs for stable reference in async callbacks
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  // --- HELPER METRIC FORMATTING ---
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatSpeed = (bytesPerSecond: number) => {
    return formatBytes(bytesPerSecond) + '/s';
  };

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return '--:--';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  // --- WebRTC CONFIGURATION (ICE SERVERS) ---
  const getIceServers = useCallback((): RTCIceServer[] => {
    const servers: RTCIceServer[] = [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
          'stun:stun3.l.google.com:19302',
          'stun:stun4.l.google.com:19302',
        ],
      },
    ];

    // Optional Fallback TURN configuration
    const turnUrl = process.env.NEXT_PUBLIC_METERED_TURN_URL;
    const turnUsername = process.env.NEXT_PUBLIC_METERED_TURN_USERNAME;
    const turnPassword = process.env.NEXT_PUBLIC_METERED_TURN_PASSWORD;

    if (turnUrl) {
      // 1. Check if the environment variable itself is a JSON array (Metered API response / list of iceServers)
      try {
        const parsed = JSON.parse(turnUrl);
        if (Array.isArray(parsed)) {
          const parsedServers: RTCIceServer[] = [];
          for (const item of parsed) {
            if (item && item.urls) {
              let urls = item.urls;
              if (Array.isArray(urls)) {
                urls = urls.map((u: string) => {
                  if (typeof u === 'string') {
                    const trimmed = u.trim();
                    if (!trimmed.startsWith('turn:') && !trimmed.startsWith('turns:') && !trimmed.startsWith('stun:')) {
                      return `turn:${trimmed}`;
                    }
                    return trimmed;
                  }
                  return u;
                });
              } else if (typeof urls === 'string') {
                const trimmed = urls.trim();
                if (!trimmed.startsWith('turn:') && !trimmed.startsWith('turns:') && !trimmed.startsWith('stun:')) {
                  urls = `turn:${trimmed}`;
                }
              }
              parsedServers.push({
                ...item,
                urls: urls,
              });
            }
          }
          if (parsedServers.length > 0) {
            servers.push(...parsedServers);
            return servers;
          }
        }
      } catch (e) {
        // Not a JSON array, proceed to parse as a raw string or comma-separated list
      }

      // 2. Comma separated or single string
      const urlsList = turnUrl.split(',').map(u => u.trim()).filter(Boolean);
      const turnUrls: string[] = [];
      const stunUrls: string[] = [];

      for (const u of urlsList) {
        let normalized = u;
        if (!u.startsWith('turn:') && !u.startsWith('turns:') && !u.startsWith('stun:')) {
          // If the scheme is omitted, prepend turn: to make it a valid URI
          normalized = `turn:${u}`;
        }

        if (normalized.startsWith('turn:') || normalized.startsWith('turns:')) {
          turnUrls.push(normalized);
          // If it is on 443 (typical for SSL/TLS TURN) and does not define a transport, add transport=tcp as a fallback option
          if (normalized.includes(':443') && !normalized.includes('transport=')) {
            const separator = normalized.includes('?') ? '&' : '?';
            turnUrls.push(`${normalized}${separator}transport=tcp`);
          }
        } else if (normalized.startsWith('stun:')) {
          stunUrls.push(normalized);
        }
      }

      if (turnUrls.length > 0) {
        servers.push({
          urls: turnUrls,
          username: turnUsername || undefined,
          credential: turnPassword || undefined,
        });
      }
      if (stunUrls.length > 0) {
        servers.push({
          urls: stunUrls,
        });
      }
    }

    return servers;
  }, []);

  // --- DISCONNECT / CLEANUP LOGIC ---
  const handleDisconnect = useCallback((notify: boolean, isIntentional = false) => {
    // 1. Notify peer if required
    if (notify) {
      sendSignalMessage({type: isIntentional ? 'intentional-disconnect' : 'webrtc-failed'});
    }

    // 2. Abort file reading
    if (fileReaderRef.current) {
      try {
        fileReaderRef.current.abort();
      } catch (e) {}
      fileReaderRef.current = null;
    }

    // 3. Close WebRTC DataChannel
    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch (e) {}
      dataChannelRef.current = null;
    }

    // 4. Close WebRTC PeerConnection
    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch (e) {}
      peerConnectionRef.current = null;
    }

    // 5. Unsubscribe & Leave Supabase Channel (ONLY IF INTENTIONAL DISCONNECT)
    if (isIntentional && channelRef.current) {
      try {
        const supabase = supabaseClientRef.current;
        if (supabase) {
          supabase.removeChannel(channelRef.current);
        }
      } catch (e) {}
      channelRef.current = null;
    }

    // 6. Reset states
    if (isIntentional) {
      isSubscribedRef.current = false;
      outgoingSignalingQueueRef.current = [];
      incomingSignalingQueueRef.current = [];
      if (subscriptionRetryTimeoutRef.current) {
        clearTimeout(subscriptionRetryTimeoutRef.current);
        subscriptionRetryTimeoutRef.current = null;
      }
      if (joinRetryIntervalRef.current) {
        clearInterval(joinRetryIntervalRef.current);
        joinRetryIntervalRef.current = null;
      }
      setRoomCode('');
      setInputCode(['', '', '', '']);
      setRole(null);
      setStatus('home');
      setDownloadQueue([]);
      if (html5QrCodeScannerRef.current) {
        try {
          if (html5QrCodeScannerRef.current.isScanning) {
            html5QrCodeScannerRef.current.stop().catch((e: any) => console.error(e));
          }
        } catch (e) {}
        html5QrCodeScannerRef.current = null;
      }
      setIsScanning(false);
    } else {
      // Soft reset of connection state, but keep room active
      const currentRole = roleRef.current;
      if (currentRole === 'sender') {
        setStatus('sender-pairing');
      } else if (currentRole === 'receiver') {
        setStatus('connecting');
      }
    }

    pendingCandidatesRef.current = [];
    addDebugLog(
      isIntentional 
        ? 'Disconnected. Session states have been cleared.' 
        : 'WebRTC connection reset. Signaling channel remains active.', 
      'info'
    );

    setSelectedFile(null);
    setStats(null);
    setIsConnected(false);
    chunksReceivedRef.current = [];
    receivedBytesRef.current = 0;
    prevStatsTimeRef.current = 0;
    receivedMetadataRef.current = null;
  }, [addDebugLog, setRole, setDownloadQueue, sendSignalMessage]);

  // --- AUTOMATIC CLEANUP ON UNMOUNT ---
  useEffect(() => {
    return () => {
      if (joinRetryIntervalRef.current) {
        clearInterval(joinRetryIntervalRef.current);
      }
      if (fileReaderRef.current) {
        try { fileReaderRef.current.abort(); } catch (e) {}
      }
      if (dataChannelRef.current) {
        try { dataChannelRef.current.close(); } catch (e) {}
      }
      if (peerConnectionRef.current) {
        try { peerConnectionRef.current.close(); } catch (e) {}
      }
      if (channelRef.current && supabaseClientRef.current) {
        try { supabaseClientRef.current.removeChannel(channelRef.current); } catch (e) {}
      }
      if (html5QrCodeScannerRef.current) {
        try {
          if (html5QrCodeScannerRef.current.isScanning) {
            html5QrCodeScannerRef.current.stop().catch((e: any) => console.error(e));
          }
        } catch (e) {}
      }
    };
  }, []);

  // --- PEER CONNECTION LISTENER HELPER ---
  const setupPeerConnectionListeners = useCallback((pc: RTCPeerConnection, side: 'sender' | 'receiver') => {
    pc.oniceconnectionstatechange = () => {
      addDebugLog(`[${side}] ICE connection state changed: ${pc.iceConnectionState}`, 
        pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed' ? 'success' :
        pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' ? 'error' : 'info'
      );
    };

    pc.onconnectionstatechange = () => {
      addDebugLog(`[${side}] Connection state changed: ${pc.connectionState}`,
        pc.connectionState === 'connected' ? 'success' :
        pc.connectionState === 'failed' || pc.connectionState === 'closed' ? 'error' : 'info'
      );
      if (pc.connectionState === 'connected') {
        setIsConnected(true);
        setStatus('connected');
      } else if (
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        handleDisconnect(true, false);
      } else if (pc.connectionState === 'disconnected') {
        addDebugLog(`[${side}] Connection temporarily disconnected. Waiting to see if it recovers...`, 'warn');
      }
    };

    pc.onsignalingstatechange = () => {
      addDebugLog(`[${side}] Signaling state changed: ${pc.signalingState}`, 'info');
    };
  }, [addDebugLog, handleDisconnect]);

  // --- RECEIVER DATA CHANNEL SETUP ---
  const setupReceiverDataChannel = useCallback((dc: RTCDataChannel) => {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      addDebugLog("Receiver DataChannel 'fileTransfer' successfully opened and ready!", 'success');
      setIsConnected(true);
      setStatus('connected');
    };

    dc.onclose = () => {
      addDebugLog("Receiver DataChannel 'fileTransfer' closed.", 'warn');
      handleDisconnect(true, false);
    };

    dc.onerror = (err) => {
      addDebugLog(`Receiver DataChannel error: ${JSON.stringify(err)}`, 'error');
      setError('Data channel error occurred.');
    };

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // String/JSON Message: metadata, control signals
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'metadata') {
            addDebugLog(`Received file metadata: "${msg.name}" (${formatBytes(msg.size)})`, 'success');
            receivedMetadataRef.current = {
              name: msg.name,
              size: msg.size,
              type: msg.mimeType,
            };
            chunksReceivedRef.current = [];
            receivedBytesRef.current = 0;
            prevStatsTimeRef.current = 0;

            setStats({
              fileName: msg.name,
              fileSize: msg.size,
              progress: 0,
              transferredBytes: 0,
              speed: 0,
              remainingTime: 0,
              startTime: Date.now(),
            });
            setStatus('transferring');
          } else if (msg.type === 'cancel') {
            addDebugLog('File transfer cancelled by sender.', 'warn');
            setStats(null);
            setStatus('connected');
            setError('File transfer was cancelled by the sender.');
          }
        } catch (e) {
          console.error('Error parsing message string:', e);
        }
      } else {
        // Binary Chunk (ArrayBuffer)
        const chunk = event.data as ArrayBuffer;
        chunksReceivedRef.current.push(chunk);
        receivedBytesRef.current += chunk.byteLength;
        const receivedBytes = receivedBytesRef.current;

        const meta = receivedMetadataRef.current;
        if (meta) {
          const now = Date.now();
          const isComplete = receivedBytes >= meta.size;

          if (isComplete || now - prevStatsTimeRef.current > 150) {
            prevStatsTimeRef.current = now;

            setStats((prev) => {
              if (!prev) return null;
              const elapsed = (now - prev.startTime) / 1000 || 0.001;
              const speed = receivedBytes / elapsed;
              const progress = Math.min((receivedBytes / meta.size) * 100, 100);
              const remainingBytes = meta.size - receivedBytes;
              const remainingTime = speed > 0 ? remainingBytes / speed : 0;

              return {
                ...prev,
                progress,
                transferredBytes: receivedBytes,
                speed,
                remainingTime,
              };
            });
          }

          if (isComplete) {
            addDebugLog('All file chunks received completely!', 'success');

            const newFileId = Math.random().toString(36).substring(2, 9);
            const newQueuedFile = {
              id: newFileId,
              name: meta.name,
              size: meta.size,
              type: meta.type || 'application/octet-stream',
              chunks: [...chunksReceivedRef.current],
              downloaded: false,
              receivedBytes: receivedBytes,
            };

            setDownloadQueue((prev) => {
              if (prev.some(f => f.name === meta.name && f.size === meta.size && f.chunks.length === chunksReceivedRef.current.length)) {
                return prev;
              }
              return [...prev, newQueuedFile];
            });

            setStatus('complete');
          }
        }
      }
    };
  }, [handleDisconnect, addDebugLog, setDownloadQueue]);

  // --- RECEIVER ANSWER CREATION ---
  const handleOffer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
    addDebugLog('[receiver] Received SDP Offer from sender. Starting PeerConnection setup...', 'info');
    setStatus('connecting');

    // Clear the retry interval since we got the offer
    if (joinRetryIntervalRef.current) {
      addDebugLog('[receiver] Offer received. Stopping join retry interval.', 'success');
      clearInterval(joinRetryIntervalRef.current);
      joinRetryIntervalRef.current = null;
    }

    const servers = getIceServers();
    addDebugLog(`[receiver] Configuring RTCPeerConnection with ICE servers: ${JSON.stringify(servers.map(s => s.urls))}`, 'info');

    const pc = new RTCPeerConnection({iceServers: servers});
    peerConnectionRef.current = pc;

    setupPeerConnectionListeners(pc, 'receiver');

    // Direct exchange of local candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        addDebugLog(`[receiver] Gathered local ICE candidate: ${event.candidate.candidate.substring(0, 40)}...`, 'info');
        addDebugLog('[receiver] Broadcasting gathered local ICE candidate...', 'info');
        const candJson = event.candidate.toJSON();
        sendSignalMessage({type: 'candidate', candidate: candJson});
      } else {
        addDebugLog('[receiver] Completed local ICE candidate gathering.', 'success');
      }
    };

    // Receive sender's data channel
    pc.ondatachannel = (event) => {
      const dc = event.channel;
      addDebugLog(`[receiver] Received remote RTCDataChannel: "${dc.label}"`, 'success');
      dataChannelRef.current = dc;
      setupReceiverDataChannel(dc);
    };

    addDebugLog('[receiver] Setting remote description (Offer)...', 'info');
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    addDebugLog('[receiver] Remote description (Offer) set successfully.', 'success');

    // Process queued candidates
    const pending = pendingCandidatesRef.current;
    addDebugLog(`[receiver] Processing ${pending.length} pending candidate(s)...`, 'info');
    for (const cand of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
        addDebugLog('[receiver] Successfully added queued remote ICE candidate.', 'success');
      } catch (e: any) {
        addDebugLog(`[receiver] Failed to add queued remote ICE candidate: ${e.message || e}`, 'error');
      }
    }
    pendingCandidatesRef.current = [];

    addDebugLog('[receiver] Creating SDP Answer...', 'info');
    const answer = await pc.createAnswer();
    addDebugLog('[receiver] Setting local description (Answer)...', 'info');
    await pc.setLocalDescription(answer);
    addDebugLog('[receiver] SDP Answer created and set locally.', 'success');

    addDebugLog('[receiver] Broadcasting SDP Answer...', 'info');
    sendSignalMessage({type: 'answer', sdp: answer});
  }, [getIceServers, setupReceiverDataChannel, setupPeerConnectionListeners, addDebugLog, sendSignalMessage]);

  // --- SENDER INITIATE CONNECTION ---
  const initiatePeerConnection = useCallback(async () => {
    addDebugLog('[sender] Initiating peer connection...', 'info');
    setStatus('connecting');

    const servers = getIceServers();
    addDebugLog(`[sender] Configuring RTCPeerConnection with ICE servers: ${JSON.stringify(servers.map(s => s.urls))}`, 'info');

    const pc = new RTCPeerConnection({iceServers: servers});
    peerConnectionRef.current = pc;

    setupPeerConnectionListeners(pc, 'sender');

    // Send local candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        addDebugLog(`[sender] Gathered local ICE candidate: ${event.candidate.candidate.substring(0, 40)}...`, 'info');
        addDebugLog('[sender] Broadcasting gathered local ICE candidate...', 'info');
        const candJson = event.candidate.toJSON();
        sendSignalMessage({type: 'candidate', candidate: candJson});
      } else {
        addDebugLog('[sender] Completed local ICE candidate gathering.', 'success');
      }
    };

    // Create DataChannel (as sender)
    addDebugLog("[sender] Creating RTCDataChannel 'fileTransfer'...", 'info');
    const dc = pc.createDataChannel('fileTransfer', {ordered: true});
    dataChannelRef.current = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 65536; // 64KB threshold for backpressure low event

    dc.onopen = () => {
      addDebugLog("[sender] DataChannel 'fileTransfer' successfully opened!", 'success');
      setIsConnected(true);
      setStatus('connected');
    };

    dc.onclose = () => {
      addDebugLog("[sender] DataChannel 'fileTransfer' closed.", 'warn');
      handleDisconnect(true, false);
    };

    dc.onerror = (err) => {
      addDebugLog(`[sender] DataChannel error: ${JSON.stringify(err)}`, 'error');
      setError('Data channel error occurred.');
    };

    addDebugLog('[sender] Creating SDP Offer...', 'info');
    const offer = await pc.createOffer();
    addDebugLog('[sender] Setting local description (Offer)...', 'info');
    await pc.setLocalDescription(offer);
    addDebugLog('[sender] SDP Offer created and set locally.', 'success');

    addDebugLog('[sender] Broadcasting SDP Offer...', 'info');
    sendSignalMessage({type: 'offer', sdp: offer});
  }, [getIceServers, handleDisconnect, setupPeerConnectionListeners, addDebugLog, sendSignalMessage]);

  // --- SIGNAL ROUTER (BROADCAST HANDLER) ---
  const handleSignalMessage = useCallback(async (payload: any) => {
    try {
      if (!payload) return;
      addDebugLog(`Received signal message of type: "${payload.type}"`, 'info');

      const currentRole = roleRef.current;
      if (payload.type === 'join' && currentRole === 'sender') {
        addDebugLog(`Received 'join' signal from receiver.`, 'info');
        const pc = peerConnectionRef.current;
        if (pc) {
          if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') {
            addDebugLog('Already connected. Ignoring duplicate join signal.', 'info');
            return;
          }
          if (pc.localDescription && pc.localDescription.type === 'offer') {
            addDebugLog('Negotiation in progress. Re-broadcasting existing SDP Offer...', 'warn');
            sendSignalMessage({type: 'offer', sdp: pc.localDescription});
            return;
          }
          addDebugLog('PeerConnection exists but is inactive. Closing and recreating...', 'warn');
          try { pc.close(); } catch (e) {}
          peerConnectionRef.current = null;
        }
        await initiatePeerConnection();
      } else if (payload.type === 'offer' && currentRole === 'receiver') {
        addDebugLog(`Received 'offer' signal from sender.`, 'info');
        const pc = peerConnectionRef.current;
        if (pc) {
          if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') {
            addDebugLog('Already connected. Ignoring duplicate offer signal.', 'info');
            return;
          }
          if (pc.localDescription && pc.localDescription.type === 'answer') {
            addDebugLog('Already set remote offer and local answer. Re-broadcasting SDP Answer...', 'warn');
            sendSignalMessage({type: 'answer', sdp: pc.localDescription});
            return;
          }
          addDebugLog('PeerConnection exists but not negotiated. Closing and recreating...', 'warn');
          try { pc.close(); } catch (e) {}
          peerConnectionRef.current = null;
        }
        await handleOffer(payload.sdp);
      } else if (payload.type === 'answer' && currentRole === 'sender') {
        addDebugLog('Received SDP Answer.', 'info');
        const pc = peerConnectionRef.current;
        if (pc) {
          if (pc.signalingState === 'stable') {
            addDebugLog('Signaling state is already stable. Ignoring duplicate answer.', 'success');
            return;
          }
          addDebugLog('Setting remote description (Answer)...', 'info');
          await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          addDebugLog('Remote description (Answer) set successfully.', 'success');

          // Process queued candidates
          const pending = pendingCandidatesRef.current;
          addDebugLog(`Processing ${pending.length} pending candidate(s)...`, 'info');
          for (const cand of pending) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
              addDebugLog('Successfully added queued remote ICE candidate.', 'success');
            } catch (e: any) {
              addDebugLog(`Failed to add queued remote ICE candidate: ${e.message || e}`, 'error');
            }
          }
          pendingCandidatesRef.current = [];
        }
      } else if (payload.type === 'candidate') {
        const pc = peerConnectionRef.current;
        if (payload.candidate) {
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            try {
              addDebugLog(`Adding remote ICE candidate: ${payload.candidate.candidate.substring(0, 40)}...`, 'info');
              await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
              addDebugLog('Remote ICE candidate added successfully.', 'success');
            } catch (e: any) {
              addDebugLog(`Error adding remote ICE candidate: ${e.message || e}`, 'error');
            }
          } else {
            addDebugLog('Queuing remote ICE candidate (remoteDescription not set yet)', 'warn');
            pendingCandidatesRef.current.push(payload.candidate);
          }
        }
      } else if (payload.type === 'intentional-disconnect') {
        addDebugLog('Remote peer disconnected intentionally.', 'warn');
        setError('The other device disconnected.');
        handleDisconnect(false, true); // Hard/Intentional disconnect
      } else if (payload.type === 'webrtc-failed' || payload.type === 'disconnect') {
        addDebugLog('Remote peer reported connection failure/reset. Attempting to keep signaling channel alive.', 'warn');
        handleDisconnect(false, false); // Soft/Non-intentional disconnect
      } else if (payload.type === 'download-complete') {
        addDebugLog('Receiver completed file download signal received.', 'success');
      }
    } catch (err: any) {
      console.error('Error processing signaling message:', err);
      addDebugLog(`Connection handshake failed: ${err.message || err}`, 'error');
      setError(`Connection handshake failed: ${err.message || err}`);
    }
  }, [initiatePeerConnection, handleOffer, handleDisconnect, addDebugLog, sendSignalMessage]);

  // Sync handleSignalMessage callback to ref to avoid stale closure issues in the event listener
  useEffect(() => {
    handleSignalMessageRef.current = handleSignalMessage;
  }, [handleSignalMessage]);

  // --- CHANNEL SUBSCRIPTION & JOIN ---
  const joinRoomChannel = useCallback((code: string, currentRole: 'sender' | 'receiver', retryAttempt = 0) => {
    addDebugLog(`Attempting to join signaling room: ${code} as ${currentRole} (attempt ${retryAttempt})...`, 'info');
    const supabase = getSupabaseClientInstance();
    if (!supabase) {
      addDebugLog('Failed to obtain a valid Supabase client instance. Check configuration.', 'error');
      setError('Supabase is not configured. Please add NEXT_PUBLIC_SUPABASE_ANON_KEY to your environment.');
      setStatus('home');
      setRole(null);
      return;
    }

    supabaseClientRef.current = supabase;

    // Reset subscription state and queues for room isolation
    isSubscribedRef.current = false;
    outgoingSignalingQueueRef.current = [];
    incomingSignalingQueueRef.current = [];

    if (subscriptionRetryTimeoutRef.current) {
      clearTimeout(subscriptionRetryTimeoutRef.current);
      subscriptionRetryTimeoutRef.current = null;
    }

    // Clean up any existing channel before subscribing to a new one
    if (channelRef.current) {
      addDebugLog('Cleaning up existing channel subscription before joining new one...', 'warn');
      try {
        supabase.removeChannel(channelRef.current);
      } catch (e) {}
      channelRef.current = null;
    }

    const channelName = `room-transfer-${code}`;
    addDebugLog(`Creating Supabase channel: "${channelName}"...`, 'info');
    const channel = supabase.channel(channelName, {
      config: {
        broadcast: {self: false},
      },
    });

    channelRef.current = channel;

    channel
      .on('broadcast', {event: 'signal'}, ({payload}) => {
        addDebugLog(`Supabase Realtime received signal: "${payload?.type}"`, 'success');
        if (isSubscribedRef.current) {
          if (handleSignalMessageRef.current) {
            handleSignalMessageRef.current(payload);
          }
        } else {
          addDebugLog(`Channel not fully subscribed yet. Queuing incoming signal: "${payload?.type}"`, 'warn');
          incomingSignalingQueueRef.current.push(payload);
        }
      })
      .subscribe((status, err) => {
        addDebugLog(`Supabase Realtime subscription status: ${status}${err ? ` - Error: ${JSON.stringify(err)}` : ''}`, status === 'SUBSCRIBED' ? 'success' : 'warn');
        
        if (status === 'SUBSCRIBED') {
          addDebugLog(`Successfully subscribed to signaling room channel: ${code}`, 'success');
          isSubscribedRef.current = true;

          // 1. Process queued incoming signals first
          const incoming = [...incomingSignalingQueueRef.current];
          incomingSignalingQueueRef.current = [];
          if (incoming.length > 0) {
            addDebugLog(`Processing ${incoming.length} queued incoming signal(s)...`, 'info');
            incoming.forEach((pay) => {
              if (handleSignalMessageRef.current) {
                handleSignalMessageRef.current(pay);
              }
            });
          }

          // 2. Flush queued outgoing signals
          const outgoing = [...outgoingSignalingQueueRef.current];
          outgoingSignalingQueueRef.current = [];
          if (outgoing.length > 0) {
            addDebugLog(`Broadcasting ${outgoing.length} queued outgoing signal(s)...`, 'info');
            outgoing.forEach((pay) => {
              channel.send({
                type: 'broadcast',
                event: 'signal',
                payload: pay,
              }).catch((e) => {
                console.error('Error sending queued signal:', e);
                addDebugLog(`Failed to send queued signal: ${e.message || e}`, 'error');
              });
            });
          }

          // 3. Setup join/negotiation routine for receiver
          if (currentRole === 'receiver') {
            // Automatically prompt sender to start WebRTC creation
            addDebugLog(`Broadcasting 'join' signal to room ${code}...`, 'info');
            sendSignalMessage({type: 'join'});

            // Setup robust join interval to retry until sender responds with an offer
            if (joinRetryIntervalRef.current) {
              clearInterval(joinRetryIntervalRef.current);
            }
            let attempt = 1;
            joinRetryIntervalRef.current = setInterval(() => {
              // Only retry if we are still connecting and haven't set remote offer
              if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
                if (joinRetryIntervalRef.current) {
                  addDebugLog('Remote offer received. Stopping join retry interval.', 'success');
                  clearInterval(joinRetryIntervalRef.current);
                  joinRetryIntervalRef.current = null;
                }
                return;
              }

              attempt++;
              addDebugLog(`Retrying 'join' signal broadcast (attempt ${attempt})...`, 'info');
              sendSignalMessage({type: 'join'});
            }, 2500);
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
          addDebugLog(`Channel error/close/timeout. Status is: ${status}`, 'error');
          isSubscribedRef.current = false;
          
          // Only retry if we are still active in this room and didn't go back home
          if (statusRef.current !== 'home' && roomCodeRef.current === code) {
            const maxRetries = 6;
            if (retryAttempt < maxRetries) {
              const delay = Math.min(15000, Math.pow(2, retryAttempt) * 1000 + Math.random() * 500);
              addDebugLog(`Subscription failed/timed out. Automatically retrying in ${(delay / 1000).toFixed(1)}s (Attempt ${retryAttempt + 1}/${maxRetries}) with exponential backoff...`, 'warn');
              setError(`Signaling connection issue (attempting retry ${retryAttempt + 1}/${maxRetries})...`);
              
              if (subscriptionRetryTimeoutRef.current) {
                clearTimeout(subscriptionRetryTimeoutRef.current);
              }
              subscriptionRetryTimeoutRef.current = setTimeout(() => {
                if (statusRef.current !== 'home' && roomCodeRef.current === code && joinRoomChannelRef.current) {
                  joinRoomChannelRef.current(code, currentRole, retryAttempt + 1);
                }
              }, delay);
            } else {
              addDebugLog('Reached max subscription retry attempts. Connection failed.', 'error');
              setError('Connection failed. Please check your internet or try creating/joining a different room.');
            }
          }
        }
      });
  }, [getSupabaseClientInstance, addDebugLog, setRole, sendSignalMessage]);

  useEffect(() => {
    joinRoomChannelRef.current = joinRoomChannel;
  }, [joinRoomChannel]);

  // --- SENDER: INITIALIZE ROOM ---
  const handleCreateRoom = () => {
    setError(null);
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    setRoomCode(code);
    setRole('sender');
    setStatus('sender-pairing');
    joinRoomChannel(code, 'sender');
  };

  // --- RECEIVER: INITIALIZE JOIN ---
  const handleJoinRoom = useCallback((code: string) => {
    setError(null);
    if (code.length !== 4 || !/^\d{4}$/.test(code)) {
      setError('Invalid code format. Enter exactly 4 numbers.');
      return;
    }
    setRoomCode(code);
    setRole('receiver');
    setStatus('connecting');
    joinRoomChannel(code, 'receiver');
  }, [joinRoomChannel, setRole]);

  // Handle copy room link to clipboard
  const handleCopyLink = useCallback(() => {
    const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}/?room=${roomCode}` : '';
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [roomCode]);

  // Check for 'room' parameter in query URL on initial load to auto-join
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const roomParam = params.get('room');
      if (roomParam && roomParam.length === 4 && /^\d{4}$/.test(roomParam)) {
        // Clean URL to prevent re-joining on reload
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
        // Automatically join the room asynchronously to avoid React cascade warnings
        const timer = setTimeout(() => {
          handleJoinRoom(roomParam);
        }, 0);
        return () => clearTimeout(timer);
      }
    }
  }, [handleJoinRoom]);

  // --- RECEIVER: QR CODE SCANNER ENGINE ---
  const startScanning = useCallback(async () => {
    setIsScanning(true);
    setError(null);

    // Give a microtask delay so the DOM element with id="qr-reader" is rendered first
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      
      const scanner = new Html5Qrcode('qr-reader');
      html5QrCodeScannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (width, height) => {
            const size = Math.min(width, height) * 0.75;
            return { width: size, height: size };
          },
        },
        (decodedText) => {
          let code = '';
          if (decodedText.length === 4 && /^\d{4}$/.test(decodedText)) {
            code = decodedText;
          } else {
            try {
              const url = new URL(decodedText);
              const r = url.searchParams.get('room');
              if (r && r.length === 4 && /^\d{4}$/.test(r)) {
                code = r;
              }
            } catch (e) {
              const match = decodedText.match(/\b\d{4}\b/);
              if (match) {
                code = match[0];
              }
            }
          }

          if (code) {
            scanner.stop().then(() => {
              setIsScanning(false);
              handleJoinRoom(code);
            }).catch((err) => {
              console.error('Failed to stop scanner:', err);
              setIsScanning(false);
              handleJoinRoom(code);
            });
          } else {
            setError('Decoded QR code is not a valid room code or link.');
          }
        },
        () => {
          // Verbose qr code scanning frame errors (no QR found in this frame) can be ignored
        }
      );
    } catch (err: any) {
      console.error('Scanner start error:', err);
      setError(`Failed to access camera: ${err.message || err}. Please allow camera permissions.`);
      setIsScanning(false);
    }
  }, [handleJoinRoom]);

  const stopScanning = useCallback(async () => {
    if (html5QrCodeScannerRef.current) {
      try {
        if (html5QrCodeScannerRef.current.isScanning) {
          await html5QrCodeScannerRef.current.stop();
        }
      } catch (e) {
        console.error('Error stopping scanner:', e);
      }
      html5QrCodeScannerRef.current = null;
    }
    setIsScanning(false);
  }, []);

  // --- SENDER: FILE SENDER ENGINE ---
  const sendFile = async (file: File) => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== 'open') {
      setError('Direct peer connection is lost. Reconnect and try again.');
      return;
    }

    setSelectedFile(file);
    setStatus('transferring');

    const totalSize = file.size;
    const mimeType = file.type || 'application/octet-stream';
    const name = file.name;

    // Send metadata packet to Receiver
    dc.send(
      JSON.stringify({
        type: 'metadata',
        name,
        size: totalSize,
        mimeType,
      })
    );

    setStats({
      fileName: name,
      fileSize: totalSize,
      progress: 0,
      transferredBytes: 0,
      speed: 0,
      remainingTime: 0,
      startTime: Date.now(),
    });

    // Dynamic chunk size selection based on file size for optimal overhead vs compatibility
    const CHUNK_SIZE = totalSize > 50 * 1024 * 1024 
      ? 262144  // 256KB for files > 50MB
      : totalSize > 5 * 1024 * 1024 
        ? 131072 // 128KB for files > 5MB
        : 65536; // 64KB for small files

    const HIGH_WATERMARK = Math.max(4194304, CHUNK_SIZE * 32); // 4MB - 8MB high watermark
    const LOW_WATERMARK = Math.max(1048576, CHUNK_SIZE * 8);  // 1MB - 2MB low watermark threshold
    
    let offset = 0;
    const startTime = Date.now();
    let lastStatsUpdateTime = 0;
    let isSending = false;

    // Configure the low threshold watermark on the channel
    try {
      dc.bufferedAmountLowThreshold = LOW_WATERMARK;
    } catch (e) {
      console.warn('Could not set bufferedAmountLowThreshold:', e);
    }

    // SPEED OPTIMIZATION 1: If file is <= 100MB, pre-read the entire file into memory as a single ArrayBuffer.
    // This bypasses asynchronous file slice reading overhead completely during network transmission.
    if (totalSize <= 100 * 1024 * 1024) {
      file.arrayBuffer().then((entireBuffer) => {
        if (dc.readyState !== 'open') return;

        const sendFromBuffer = () => {
          if (dc.readyState !== 'open' || isSending) return;
          isSending = true;

          try {
            while (offset < totalSize) {
              if (dc.bufferedAmount >= HIGH_WATERMARK) {
                return; // Backpressure triggered, wait for bufferedamountlow
              }

              const sliceSize = Math.min(CHUNK_SIZE, totalSize - offset);
              const chunk = entireBuffer.slice(offset, offset + sliceSize);
              dc.send(chunk);
              offset += sliceSize;

              // Throttled stats update (every 250ms to keep CPU free for transfer)
              const now = Date.now();
              if (now - lastStatsUpdateTime > 250 || offset >= totalSize) {
                lastStatsUpdateTime = now;
                const elapsed = (now - startTime) / 1000 || 0.001;
                const speed = offset / elapsed;
                const progress = Math.min((offset / totalSize) * 100, 100);
                const remainingBytes = totalSize - offset;
                const remainingTime = speed > 0 ? remainingBytes / speed : 0;

                setStats({
                  fileName: name,
                  fileSize: totalSize,
                  progress,
                  transferredBytes: offset,
                  speed,
                  remainingTime,
                  startTime,
                });
              }
            }

            if (offset >= totalSize) {
              dc.removeEventListener('bufferedamountlow', handleBufferedAmountLow);
              setStatus('complete');
            }
          } catch (e) {
            console.error('Error writing chunk to RTCDataChannel:', e);
            setError('Transmission disrupted. Let’s try reconnecting.');
            handleDisconnect(true, false);
          } finally {
            isSending = false;
          }
        };

        const handleBufferedAmountLow = () => {
          sendFromBuffer();
        };
        dc.addEventListener('bufferedamountlow', handleBufferedAmountLow);

        // Start sending
        sendFromBuffer();
      }).catch((err) => {
        console.error('Error reading entire file buffer:', err);
        setError('Failed to read file.');
        handleDisconnect(true, false);
      });
      return;
    }

    // SPEED OPTIMIZATION 2: Pipelined parallel-reading sliding window for files > 100MB.
    // Keeps up to 4 concurrent asynchronous slice.arrayBuffer() reads pending in flight, 
    // caching them in a Map to preserve sequential order and avoid thread-blocking.
    const MAX_CONCURRENT_READS = 4;
    const MAX_PRELOAD_CHUNKS = 40; // ~10MB buffer maximum
    
    let nextReadOffset = 0;
    const loadedChunks = new Map<number, ArrayBuffer>();
    let activeReads = 0;

    const preloadAndSend = () => {
      if (dc.readyState !== 'open') return;

      // 1. Maintain concurrent async reads
      while (
        activeReads < MAX_CONCURRENT_READS && 
        nextReadOffset < totalSize && 
        loadedChunks.size < MAX_PRELOAD_CHUNKS
      ) {
        const currentReadOffset = nextReadOffset;
        const sliceSize = Math.min(CHUNK_SIZE, totalSize - currentReadOffset);
        nextReadOffset += sliceSize;
        activeReads++;

        const slice = file.slice(currentReadOffset, currentReadOffset + sliceSize);
        slice.arrayBuffer()
          .then((buffer) => {
            activeReads--;
            loadedChunks.set(currentReadOffset, buffer);
            preloadAndSend();
          })
          .catch((err) => {
            console.error('Error preloading chunk:', err);
            activeReads--;
            setError('Error reading file. Please try again.');
            handleDisconnect(true, false);
          });
      }

      // 2. Transmit available sequential chunks
      if (isSending) return;
      isSending = true;

      try {
        while (offset < totalSize) {
          if (dc.bufferedAmount >= HIGH_WATERMARK) {
            return; // Wait for bufferedamountlow
          }

          const buffer = loadedChunks.get(offset);
          if (!buffer) {
            return; // Next sequential chunk is still being read. Wait.
          }

          dc.send(buffer);
          loadedChunks.delete(offset);
          offset += buffer.byteLength;

          // Throttled stats update (every 250ms to keep CPU free for transfer)
          const now = Date.now();
          if (now - lastStatsUpdateTime > 250 || offset >= totalSize) {
            lastStatsUpdateTime = now;
            const elapsed = (now - startTime) / 1000 || 0.001;
            const speed = offset / elapsed;
            const progress = Math.min((offset / totalSize) * 100, 100);
            const remainingBytes = totalSize - offset;
            const remainingTime = speed > 0 ? remainingBytes / speed : 0;

            setStats({
              fileName: name,
              fileSize: totalSize,
              progress,
              transferredBytes: offset,
              speed,
              remainingTime,
              startTime,
            });
          }
        }

        if (offset >= totalSize) {
          dc.removeEventListener('bufferedamountlow', handleBufferedAmountLow);
          setStatus('complete');
        }
      } catch (e) {
        console.error('Error writing chunk to RTCDataChannel:', e);
        setError('Transmission disrupted. Let’s try reconnecting.');
        handleDisconnect(true, false);
      } finally {
        isSending = false;
      }
    };

    const handleBufferedAmountLow = () => {
      preloadAndSend();
    };
    dc.addEventListener('bufferedamountlow', handleBufferedAmountLow);

    // Bootstrap preloading and transmission
    preloadAndSend();
  };

  // --- RECEIVER: DOWNLOAD FILE ENGINE ---
  const downloadFile = () => {
    const meta = receivedMetadataRef.current;
    const chunks = chunksReceivedRef.current;
    if (!meta || chunks.length === 0) {
      setError('No file segments found to download.');
      return;
    }

    const blob = new Blob(chunks, {type: meta.type || 'application/octet-stream'});
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // Notify sender that receiver downloaded
    sendSignalMessage({type: 'download-complete'});

    // Mark the file as downloaded in the queue
    setDownloadQueue((prev) =>
      prev.map((f) => f.name === meta.name && f.size === meta.size ? { ...f, downloaded: true } : f)
    );

    // Keep the session connected: return to connected status so they can wait/view more files
    setStatus('connected');
  };

  const downloadSingleFile = useCallback((file: { id: string; name: string; size: number; type: string; chunks: ArrayBuffer[]; downloaded: boolean; receivedBytes: number }) => {
    if (!file || file.chunks.length === 0) {
      setError('No file segments found to download.');
      return;
    }

    const blob = new Blob(file.chunks, {type: file.type || 'application/octet-stream'});
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // Notify sender that receiver downloaded
    sendSignalMessage({type: 'download-complete'});

    // Mark as downloaded in the queue
    setDownloadQueue((prev) =>
      prev.map((f) => f.id === file.id ? { ...f, downloaded: true } : f)
    );
  }, [sendSignalMessage]);

  const downloadAllFiles = useCallback(() => {
    downloadQueue.forEach((file) => {
      if (!file.downloaded) {
        downloadSingleFile(file);
      }
    });
  }, [downloadQueue, downloadSingleFile]);

  // --- DRAG AND DROP HANDLERS ---
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      sendFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      sendFile(e.target.files[0]);
    }
  };

  // --- RECEIVER DIGIT CODES HANDLERS ---
  const handleDigitInput = (val: string, index: number) => {
    if (!/^\d*$/.test(val)) return; // Allow numbers only

    const newInput = [...inputCode];
    newInput[index] = val.slice(-1); // Take last character entered
    setInputCode(newInput);

    // Move to next field if value entered
    if (val && index < 3) {
      inputRefs[index + 1].current?.focus();
    }

    // Check if code is fully populated
    const completedCode = newInput.join('');
    if (completedCode.length === 4) {
      handleJoinRoom(completedCode);
    }
  };

  const handleDigitKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key === 'Backspace' && !inputCode[index] && index > 0) {
      const newInput = [...inputCode];
      newInput[index - 1] = '';
      setInputCode(newInput);
      inputRefs[index - 1].current?.focus();
    }
  };

  const hasMissingSupabaseConfig = !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const renderDownloadQueue = () => {
    if (downloadQueue.length === 0) return null;
    return (
      <div className="mt-6 text-left border border-white/10 bg-white/[0.01] rounded-2xl p-4 w-full">
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/5">
          <h4 className="text-xs sm:text-sm font-semibold text-neutral-200 flex items-center gap-2">
            <Download className="w-4 h-4 text-indigo-400" />
            Received Files Queue ({downloadQueue.length})
          </h4>
          {downloadQueue.some(f => !f.downloaded) && (
            <button
              onClick={downloadAllFiles}
              className="text-[10px] sm:text-xs px-2.5 py-1 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 font-medium transition-all cursor-pointer"
            >
              Download All
            </button>
          )}
        </div>
        <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
          {downloadQueue.map((qFile) => (
            <div key={qFile.id} className="flex items-center justify-between p-2 rounded bg-white/[0.02] border border-white/5 text-xs">
              <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                <File className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-neutral-200 truncate">{qFile.name}</p>
                  <p className="text-[10px] text-neutral-500">{formatBytes(qFile.size)}</p>
                </div>
              </div>
              <button
                onClick={() => downloadSingleFile(qFile)}
                className={`px-2.5 py-1 rounded text-[10px] sm:text-xs font-medium transition-all flex items-center gap-1 cursor-pointer ${
                  qFile.downloaded
                    ? 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                    : 'bg-indigo-500 hover:bg-indigo-600 text-white shadow-sm'
                }`}
              >
                <Download className="w-3 h-3" />
                {qFile.downloaded ? 'Redownload' : 'Download'}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const handleInstagramClick = useCallback(() => {
    const url = "https://www.instagram.com/me_jagan?igsh=MWFuZG9kd2tjMTAwag==";
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.click();
  }, []);

  if (!isClient) return null;

  return (
    <div className="flex-1 flex flex-col justify-center items-center px-3 py-4 sm:px-4 sm:py-8 relative">
      {/* Decorative macOS blurred orb background lights */}
      <div className="absolute top-1/4 left-1/4 w-72 h-72 sm:w-96 sm:h-96 rounded-full bg-indigo-500/10 blur-[80px] sm:blur-[120px] pointer-events-none -translate-x-1/2 -translate-y-1/2" />
      <div className="absolute bottom-1/4 right-1/4 w-72 h-72 sm:w-96 sm:h-96 rounded-full bg-violet-500/10 blur-[80px] sm:blur-[120px] pointer-events-none translate-x-1/2 translate-y-1/2" />

      {/* Instagram Profile Card (Top Priority) */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        onClick={handleInstagramClick}
        className="w-full max-w-[480px] glass-panel rounded-2xl border border-white/10 p-3 mb-4 flex items-center justify-between cursor-pointer hover:bg-white/[0.04] transition-all relative overflow-hidden group select-none z-30"
      >
        <div className="flex items-center gap-3">
          {/* Left: Instagram icon inside gradient */}
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-500 via-rose-500 to-violet-600 flex items-center justify-center text-white shadow-lg shadow-rose-500/20 group-hover:scale-105 transition-transform duration-300">
            <Instagram className="w-5 h-5" />
          </div>

          {/* Center Text */}
          <div className="flex flex-col text-left">
            <span className="font-semibold text-xs sm:text-sm text-neutral-200">@me_jagan</span>
            <span className="text-[10px] sm:text-xs text-neutral-400 group-hover:text-neutral-300 transition-colors">View my Instagram Profile</span>
          </div>
        </div>

        {/* Right: Avatar Placeholder */}
        <div className="w-9 h-9 rounded-full bg-neutral-800 border border-white/10 flex items-center justify-center overflow-hidden relative shadow-inner group-hover:border-white/20 transition-colors">
          <div className="absolute inset-0 bg-gradient-to-b from-neutral-700 to-neutral-900 animate-pulse duration-[4000ms]" />
          <span className="relative font-mono text-[10px] font-bold text-neutral-300">MJ</span>
        </div>
      </motion.div>

      {/* Main macOS window wrapper */}
      <motion.div
        initial={{opacity: 0, y: 20}}
        animate={{opacity: 1, y: 0}}
        transition={{duration: 0.6, ease: [0.16, 1, 0.3, 1]}}
        className="w-full max-w-[480px] glass-panel rounded-2xl sm:rounded-3xl overflow-hidden border border-white/10 flex flex-col relative"
        id="app-window"
      >
        {/* macOS Window Title Bar */}
        <div className="flex items-center justify-between px-4 py-3 sm:px-6 sm:py-4 border-b border-white/5 relative z-20 bg-black/20">
          {/* Mac window controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleDisconnect(true, true)}
              className="relative w-3 h-3 rounded-full bg-red-500/40 hover:bg-red-500 border border-red-500/20 transition-colors after:absolute after:inset-[-8px] after:content-['']"
              title="Close and Reset"
            />
            <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/10" />
            <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/10" />
          </div>

          {/* Dynamic TOP Connection Toggle Switch (macOS/iOS style) */}
          <div className="flex items-center gap-2 sm:gap-3">
            <span className={`font-mono text-[9px] sm:text-xs tracking-wider uppercase font-bold transition-colors ${
              isConnected ? 'text-emerald-400' : 'text-red-400 font-medium'
            }`}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </span>
            <button
              onClick={() => handleDisconnect(true, true)}
              id="btn-connection"
              className={`relative w-11 h-6 rounded-full transition-colors duration-300 focus:outline-none shadow-inner border border-white/10 cursor-pointer flex items-center ${
                isConnected 
                  ? 'bg-emerald-500' 
                  : 'bg-red-500/20'
              }`}
              title={isConnected ? "Click to Disconnect" : "Disconnected"}
            >
              <motion.div
                layout
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className={`w-4 h-4 rounded-full bg-white shadow-md absolute ${
                  isConnected ? 'right-1' : 'left-1'
                }`}
              />
            </button>
          </div>

          {/* Clean minimal spacer for centering styling balance */}
          <div className="w-[52px]" />
        </div>

        {/* Center Canvas Area */}
        <div className="p-4 sm:p-8 flex-1 flex flex-col justify-center min-h-[300px] sm:min-h-[360px]" id="center-canvas">
          <AnimatePresence mode="wait">
            {error && (
              <motion.div
                initial={{opacity: 0, scale: 0.95}}
                animate={{opacity: 1, scale: 1}}
                exit={{opacity: 0, scale: 0.95}}
                className="mb-4 sm:mb-6 p-3.5 sm:p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs sm:text-sm flex gap-3 items-start"
                id="error-banner"
              >
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium">System Alert</p>
                  <p className="opacity-90 leading-relaxed text-[11px] sm:text-xs mt-0.5">{error}</p>
                </div>
                <button
                  onClick={() => setError(null)}
                  className="px-2 py-1 bg-white/5 rounded hover:bg-white/10 text-[10px] sm:text-xs font-medium transition-colors"
                >
                  Dismiss
                </button>
              </motion.div>
            )}

            {/* ERROR / SUPABASE MISSING STATE */}
            {hasMissingSupabaseConfig ? (
              <motion.div
                key="config-missing"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="text-center"
              >
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mx-auto mb-4 sm:mb-5">
                  <Lock className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />
                </div>
                <h2 className="text-base sm:text-lg font-semibold tracking-tight text-neutral-100">Configuration Required</h2>
                <p className="text-xs sm:text-sm text-neutral-400 mt-1.5 sm:mt-2 max-w-sm mx-auto leading-relaxed">
                  To establish real-time discovery rooms, please define your Supabase credentials in your environment.
                </p>
                <div className="mt-4 sm:mt-6 p-3 sm:p-4 rounded-2xl bg-neutral-900/50 border border-white/5 text-left text-xs font-mono text-neutral-300 space-y-2">
                  <p><span className="text-neutral-500"># Click Secrets panel and set:</span></p>
                  <p className="text-white">NEXT_PUBLIC_SUPABASE_ANON_KEY</p>
                </div>
              </motion.div>
            ) : status === 'home' ? (
              /* HOME SCREEN (CENTER) */
              <motion.div
                key="home-screen"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="text-center"
              >
                {/* Clean minimal macOS visual centerpiece */}
                <div className="relative w-20 h-20 sm:w-24 sm:h-24 mx-auto mb-5 sm:mb-6 flex items-center justify-center">
                  <div className="absolute inset-0 rounded-full bg-white/[0.02] border border-white/5 animate-pulse" />
                  <div className="absolute -inset-4 rounded-full bg-gradient-to-tr from-indigo-500/20 to-purple-500/20 blur-xl opacity-60 animate-pulse" />
                  <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white/[0.04] border border-white/10 shadow-lg flex items-center justify-center">
                    <Sparkles className="w-6 h-6 sm:w-8 sm:h-8 text-neutral-200" />
                  </div>
                </div>

                <h1 className="text-xl sm:text-2xl font-medium tracking-tight text-neutral-100 font-sans">
                  P2P Air Share
                </h1>
                <p className="text-xs sm:text-sm text-neutral-400 mt-1.5 sm:mt-2 max-w-xs mx-auto leading-relaxed">
                  Instant, secure peer-to-peer file transfer directly between devices. Powered fully by WebRTC.
                </p>
              </motion.div>
            ) : status === 'sender-pairing' ? (
              /* SENDER PAIRING SCREEN (CENTER) */
              <motion.div
                key="sender-pairing"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="text-center"
              >
                <p className="text-[10px] sm:text-xs uppercase tracking-widest text-indigo-400 font-semibold mb-1 sm:mb-2">PAIRING MODE</p>
                <h2 className="text-xs sm:text-sm text-neutral-400 font-medium">Scan QR code or enter numeric code</h2>

                {/* QR Code Container */}
                <div className="my-4 sm:my-6 flex flex-col items-center">
                  <div className="p-3 sm:p-4 rounded-2xl bg-white shadow-xl border border-white/15">
                    <QRCodeSVG
                      value={typeof window !== 'undefined' ? `${window.location.origin}/?room=${roomCode}` : roomCode}
                      size={130}
                      level="H"
                      includeMargin={false}
                      fgColor="#0a0a0a"
                      bgColor="#ffffff"
                    />
                  </div>
                  <p className="text-[11px] sm:text-xs text-neutral-400 mt-2.5 sm:mt-3 font-medium flex items-center gap-1.5 justify-center">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                    Scan with camera to join instantly
                  </p>
                </div>

                {/* Gorgeous room code text */}
                <div className="mb-4 sm:mb-6 py-3 px-4 sm:py-4 sm:px-6 rounded-2xl bg-white/[0.02] border border-white/10 inline-flex flex-col items-center gap-3 w-full">
                  <div className="flex items-center justify-center gap-2 sm:gap-3">
                    {roomCode.split('').map((char, i) => (
                      <span
                        key={i}
                        className="text-2xl sm:text-3xl font-mono font-semibold text-white tracking-wider bg-white/[0.04] w-9 h-11 sm:w-10 sm:h-12 flex items-center justify-center rounded-xl border border-white/10 shadow-inner"
                      >
                        {char}
                      </span>
                    ))}
                  </div>

                  {/* Copy Link Button */}
                  <button
                    onClick={handleCopyLink}
                    className="flex items-center gap-1.5 px-3.5 py-2 sm:px-3 sm:py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-xs sm:text-[11px] text-neutral-300 font-medium transition-all border border-white/5 cursor-pointer"
                  >
                    {copied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-400 font-mono">Link Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-neutral-400" />
                        <span>Copy Join Link</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="flex items-center justify-center gap-2 text-neutral-400 text-xs">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-neutral-500" />
                  <span>Waiting for receiver to join...</span>
                </div>
              </motion.div>
            ) : status === 'receiver-pairing' ? (
              /* RECEIVER PAIRING SCREEN (CENTER) */
              <motion.div
                key="receiver-pairing"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="text-center"
              >
                <p className="text-[10px] sm:text-xs uppercase tracking-widest text-indigo-400 font-semibold mb-1 sm:mb-2">JOIN ROOM</p>
                <h2 className="text-xs sm:text-sm text-neutral-400 font-medium mb-4 sm:mb-6">
                  {isScanning ? 'Scan the sender\'s QR code with your camera' : 'Enter the 4-digit code from the sender'}
                </h2>

                {isScanning ? (
                  <div className="flex flex-col items-center">
                    <div className="relative w-full max-w-[240px] sm:max-w-[280px] aspect-square rounded-2xl overflow-hidden bg-neutral-950 border border-white/10 shadow-2xl mb-4 sm:mb-5">
                      {/* Scanning visual target frame/corners */}
                      <div className="absolute top-4 left-4 w-6 h-6 border-t-2 border-l-2 border-indigo-500 z-25 rounded-tl-sm" />
                      <div className="absolute top-4 right-4 w-6 h-6 border-t-2 border-r-2 border-indigo-500 z-25 rounded-tr-sm" />
                      <div className="absolute bottom-4 left-4 w-6 h-6 border-b-2 border-l-2 border-indigo-500 z-25 rounded-bl-sm" />
                      <div className="absolute bottom-4 right-4 w-6 h-6 border-b-2 border-r-2 border-indigo-500 z-25 rounded-br-sm" />
                      
                      {/* Scanning laser line */}
                      <div className="absolute left-4 right-4 h-0.5 bg-indigo-500/80 shadow-[0_0_12px_rgba(99,102,241,0.8)] animate-scan z-20" />
                      
                      {/* html5-qrcode element */}
                      <div id="qr-reader" className="w-full h-full" style={{ minHeight: '100%' }} />
                    </div>

                    <button
                      onClick={stopScanning}
                      className="flex items-center justify-center gap-1.5 px-4 py-2.5 sm:py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-neutral-300 text-xs font-medium border border-white/10 cursor-pointer transition-all mb-4"
                    >
                      <CameraOff className="w-3.5 h-3.5" />
                      <span>Cancel Scanning / Enter Code</span>
                    </button>
                  </div>
                ) : (
                  <>
                    {/* 4 digit code inputs */}
                    <div className="flex justify-center gap-2 sm:gap-3 mb-4 sm:mb-6">
                      {inputCode.map((digit, index) => (
                        <input
                          key={index}
                          ref={inputRefs[index]}
                          type="text"
                          maxLength={1}
                          pattern="\d*"
                          value={digit}
                          onChange={(e) => handleDigitInput(e.target.value, index)}
                          onKeyDown={(e) => handleDigitKeyDown(e, index)}
                          className="w-10 h-12 sm:w-12 sm:h-14 bg-white/[0.03] border border-white/10 rounded-xl text-center text-xl sm:text-2xl font-mono text-white focus:outline-none focus:border-indigo-500/50 focus:bg-white/[0.08] transition-all shadow-inner"
                        />
                      ))}
                    </div>

                    <button
                      onClick={startScanning}
                      className="w-full py-3.5 sm:py-3 px-4 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 text-xs font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer mb-4 sm:mb-6"
                    >
                      <Camera className="w-4 h-4" />
                      SCAN SENDER&apos;S QR CODE
                    </button>
                  </>
                )}

                <button
                  onClick={() => {
                    stopScanning();
                    setStatus('home');
                  }}
                  className="py-2 px-3 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  Cancel and return
                </button>
              </motion.div>
            ) : status === 'connecting' ? (
              /* CONNECTING HANDSHAKE SCREEN (CENTER) */
              <motion.div
                key="connecting"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="text-center py-4"
              >
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full border border-white/5 bg-white/[0.02] flex items-center justify-center mx-auto mb-5 sm:mb-6 relative">
                  <RefreshCw className="w-5 h-5 sm:w-6 sm:h-6 text-indigo-400 animate-spin" />
                  <div className="absolute inset-0 rounded-full border border-indigo-500/20 animate-ping" />
                </div>
                <h2 className="text-base sm:text-lg font-medium tracking-tight text-neutral-200">Exchanging Handshakes</h2>
                <p className="text-xs sm:text-sm text-neutral-400 mt-1.5 sm:mt-2 max-w-xs mx-auto leading-relaxed">
                  Negotiating direct peer-to-peer data channel via STUN/TURN servers...
                </p>
              </motion.div>
            ) : status === 'connected' ? (
              /* CONNECTED / FILE SELECT SCREEN (CENTER) */
              <motion.div
                key="connected"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="w-full"
              >
                {role === 'sender' ? (
                  /* SENDER DESIGN */
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border border-dashed rounded-2xl p-6 sm:p-8 text-center transition-all cursor-pointer ${
                      isDragging
                        ? 'border-indigo-400 bg-indigo-500/5 scale-[0.99]'
                        : 'border-white/10 hover:border-white/20 hover:bg-white/[0.01]'
                    }`}
                  >
                    <input
                      type="file"
                      id="file-input"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                    <label htmlFor="file-input" className="cursor-pointer block w-full h-full">
                      <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-white/[0.04] border border-white/15 flex items-center justify-center mx-auto mb-3 sm:mb-4">
                        <Upload className="w-5 h-5 sm:w-6 sm:h-6 text-neutral-200" />
                      </div>
                      <h3 className="text-sm sm:text-base font-medium text-neutral-200">Select file to send</h3>
                      <p className="text-[11px] sm:text-xs text-neutral-400 mt-1 sm:mt-1.5 leading-relaxed max-w-[240px] mx-auto">
                        Drag and drop your file here, or click to browse.
                      </p>
                    </label>
                  </div>
                ) : (
                  /* RECEIVER DESIGN */
                  <div className="text-center py-4 sm:py-6">
                    <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white/[0.02] border border-white/10 flex items-center justify-center mx-auto mb-4 sm:mb-6 relative">
                      <div className="absolute inset-0 rounded-full bg-indigo-500/5 animate-pulse" />
                      <Wifi className="w-6 h-6 sm:w-7 sm:h-7 text-indigo-400 animate-pulse" />
                    </div>
                    <h3 className="text-sm sm:text-base font-medium text-neutral-200">Ready to Receive</h3>
                    <p className="text-[11px] sm:text-xs text-neutral-400 mt-1.5 sm:mt-2 max-w-xs mx-auto leading-relaxed">
                      Connected to the sender. Waiting for them to choose and transmit a file...
                    </p>
                    {renderDownloadQueue()}
                  </div>
                )}
              </motion.div>
            ) : status === 'transferring' && stats ? (
              /* ACTIVE FILE TRANSFER STATS SCREEN (CENTER) */
              <motion.div
                key="transferring"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="w-full text-left"
              >
                {/* File Metadata Overview */}
                <div className="flex items-center gap-4 mb-4 sm:mb-6 p-3.5 sm:p-4 rounded-2xl bg-white/[0.02] border border-white/5">
                  <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-400 border border-indigo-500/15">
                    <File className="w-4 h-4 sm:w-5 sm:h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-neutral-200 text-xs sm:text-sm truncate">{stats.fileName}</p>
                    <p className="text-[10px] sm:text-xs text-neutral-400 mt-0.5">{formatBytes(stats.fileSize)}</p>
                  </div>
                </div>

                {/* macOS Style Progress Bar */}
                <div className="space-y-2 mb-4 sm:mb-6">
                  <div className="flex justify-between text-[11px] sm:text-xs text-neutral-400 font-medium">
                    <span>Transferring...</span>
                    <span className="font-mono text-white">{Math.round(stats.progress)}%</span>
                  </div>
                  <div className="h-2 w-full bg-white/[0.04] rounded-full overflow-hidden border border-white/5 p-[1px]">
                    <motion.div
                      initial={{width: 0}}
                      animate={{width: `${stats.progress}%`}}
                      transition={{duration: 0.1}}
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 shadow-md shadow-indigo-500/30"
                    />
                  </div>
                </div>

                {/* Metric Bento-Grid */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-3 font-mono text-[11px] sm:text-xs text-neutral-300">
                  <div className="p-3 sm:p-3.5 rounded-xl bg-white/[0.01] border border-white/5">
                    <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-neutral-500">SPEED</p>
                    <p className="text-xs sm:text-sm font-semibold mt-1 text-white truncate">{formatSpeed(stats.speed)}</p>
                  </div>
                  <div className="p-3 sm:p-3.5 rounded-xl bg-white/[0.01] border border-white/5">
                    <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-neutral-500">EST. TIME</p>
                    <p className="text-xs sm:text-sm font-semibold mt-1 text-white truncate">{formatTime(stats.remainingTime)}</p>
                  </div>
                  <div className="p-3 sm:p-3.5 rounded-xl bg-white/[0.01] border border-white/5 col-span-2 flex justify-between items-center">
                    <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-neutral-500">TRANSFERRED</p>
                    <p className="font-semibold text-white">
                      {formatBytes(stats.transferredBytes)} <span className="text-neutral-500">/ {formatBytes(stats.fileSize)}</span>
                    </p>
                  </div>
                </div>
              </motion.div>
            ) : (
              /* COMPLETE SCREEN (CENTER) */
              <motion.div
                key="complete-screen"
                initial={{opacity: 0, y: 10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                className="text-center"
              >
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4 sm:mb-5">
                  <CheckCircle className="w-6 h-6 sm:w-7 sm:h-7 text-emerald-400" />
                </div>
                <h3 className="text-base sm:text-lg font-medium text-neutral-100">Transfer Complete</h3>
                <p className="text-xs text-neutral-400 mt-1 max-w-xs mx-auto leading-relaxed">
                  Your files were transferred directly peer-to-peer over the WebRTC channel.
                </p>

                {stats && (
                  <div className="my-4 sm:my-5 p-3 sm:p-3.5 rounded-xl bg-white/[0.01] border border-white/5 text-left inline-flex items-center gap-3 max-w-[320px] mx-auto text-xs text-neutral-300">
                    <File className="w-4 h-4 text-neutral-500 shrink-0" />
                    <span className="font-medium truncate max-w-[160px]">{stats.fileName}</span>
                    <span className="text-neutral-500">({formatBytes(stats.fileSize)})</span>
                  </div>
                )}

                {role === 'receiver' ? (
                  <div className="flex flex-col gap-2.5 w-full mt-2">
                    <motion.button
                      whileTap={{scale: 0.98}}
                      onClick={downloadFile}
                      id="btn-download"
                      className="w-full py-3.5 sm:py-3 px-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white font-medium text-sm flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20 transition-all cursor-pointer border border-indigo-400/20"
                    >
                      <Download className="w-4 h-4" />
                      Download Received File
                    </motion.button>

                    <motion.button
                      whileTap={{scale: 0.98}}
                      onClick={() => setStatus('connected')}
                      className="w-full py-2 px-4 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-neutral-300 font-medium text-xs flex items-center justify-center gap-1 transition-all cursor-pointer border border-white/10"
                    >
                      Back to Queue / Waiting
                    </motion.button>
                  </div>
                ) : (
                  <div className="mt-4 flex flex-col gap-3.5 items-center w-full">
                    <div className="text-neutral-400 text-xs flex items-center justify-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin text-neutral-500" />
                      <span>Waiting for receiver to download...</span>
                    </div>
                    <motion.button
                      whileTap={{scale: 0.98}}
                      onClick={() => setStatus('connected')}
                      className="w-full py-3 px-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white font-medium text-sm flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20 transition-all cursor-pointer border border-indigo-400/20"
                    >
                      <Plus className="w-4 h-4" />
                      Send More Files
                    </motion.button>
                  </div>
                )}

                {role === 'receiver' && renderDownloadQueue()}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom Panel Area */}
        <div className="px-4 pb-6 pt-4 sm:px-8 sm:pb-8 border-t border-white/5" id="bottom-panel">
          {status === 'home' && !hasMissingSupabaseConfig && (
            /* Standard home view only displays SEND and RECEIVE buttons */
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              <motion.button
                whileHover={{y: -1}}
                whileTap={{scale: 0.98}}
                onClick={handleCreateRoom}
                id="btn-send"
                className="py-4 rounded-2xl bg-white text-neutral-950 font-semibold text-xs sm:text-sm shadow-xl flex items-center justify-center gap-2 transition-all cursor-pointer border border-white/20 hover:bg-neutral-100"
              >
                <Upload className="w-4 h-4" />
                SEND
              </motion.button>

              <motion.button
                whileHover={{y: -1}}
                whileTap={{scale: 0.98}}
                onClick={() => setStatus('receiver-pairing')}
                id="btn-receive"
                className="py-4 rounded-2xl bg-white/[0.05] hover:bg-white/[0.08] text-white font-semibold text-xs sm:text-sm border border-white/10 shadow-xl flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <Download className="w-4 h-4" />
                RECEIVE
              </motion.button>
            </div>
          )}

          {status !== 'home' && (
            /* Sub-screen cancellation or metrics reset buttons */
            <div className="flex justify-center items-center text-xs text-neutral-500 py-2">
              <span className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-neutral-600" />
                Encrypted Connection
              </span>
            </div>
          )}
        </div>
      </motion.div>



      {/* Live System Log Console */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.5 }}
        className="w-full max-w-[480px] mt-4 sm:mt-6 bg-black/40 border border-white/5 rounded-2xl p-3 sm:p-4 font-mono text-[10px] sm:text-[11px] text-neutral-400 flex flex-col h-[160px] sm:h-[200px]"
        id="tracer-console"
      >
        <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2 shrink-0">
          <div className="flex items-center gap-1.5 font-semibold text-neutral-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            LIVE SIGNALING & WEBRTC TRACER
          </div>
          <button 
            onClick={() => setDebugLogs([])}
            className="hover:text-white transition-colors uppercase text-[9px] font-semibold border border-white/10 px-2 py-1 rounded bg-white/[0.02]"
          >
            Clear Logs
          </button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 text-left select-text">
          {debugLogs.length === 0 ? (
            <div className="text-neutral-600 text-center py-6 sm:py-10 italic">
              Ready to trace signaling events. Click SEND or RECEIVE to start...
            </div>
          ) : (
            debugLogs.map((log, i) => (
              <div key={i} className="flex gap-2 items-start leading-relaxed">
                <span className="text-neutral-600 select-none shrink-0">[{log.time}]</span>
                <span className={
                  log.type === 'success' ? 'text-emerald-400 font-medium' :
                  log.type === 'error' ? 'text-rose-400 font-semibold' :
                  log.type === 'warn' ? 'text-amber-400' : 'text-neutral-300'
                }>
                  {log.text}
                </span>
              </div>
            ))
          )}
        </div>
      </motion.div>
    </div>
  );
}
