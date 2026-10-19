import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Image, KeyboardAvoidingView, Linking,
  Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet,
  Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { askAboutImage, checkBackend, DEFAULT_API_URL, generateImage, sendToBackend } from './src/services/wukApi';
import MarkdownMessage from './src/components/MarkdownMessage';
import MatrixRain from './src/components/MatrixRain';
import { colors as c, spacing as s } from './src/theme';

const STORAGE_KEY = '@wuk72_wuk_ai_chat_v2';
const LEGACY_STORAGE_KEY = '@wuk72_wuk_ai_chat_v1';
const OLDER_STORAGE_KEY = '@wuk72_jarvis_chat_v1';
const PAGE_SIZE = 40;
const TEMP_CACHE_PREFIX = '@wuk72_cache_';
const IMAGE_CACHE_DIR = FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}wuk-ai-chat-images/` : null;
const MAX_IMAGE_BASE64_LENGTH = 4_800_000;
const webImageCache = new Map();
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const welcomeMessage = () => ({
  id: newId(), role: 'assistant', time: new Date().toISOString(),
  text: 'Welcome to WUK AI by Wuk72. Ask a question, save a note, or try a local command. Your conversations and notes stay on this device.',
});
const newConversation = (messages = [welcomeMessage()]) => ({ id: newId(), title: 'New conversation', updatedAt: new Date().toISOString(), messages });

const needsFreshResearch = raw => /\b(latest|today|yesterday|current|currently|right now|recent|news|price|cost|exchange rate|weather|score|schedule|release date|new version|updated|this year|202[5-9]|20[3-9]\d|who is the (current|new)|president|ceo|election|stock|bitcoin|\bapi\b|documentation|docs)\b/i.test(raw);

const localCommand = raw => {
  const q = raw.trim().toLowerCase();
  if (/^(hi|hello|hey|good morning|good evening)\b/.test(q)) return { reply: 'Hello. WUK AI is ready. What can I help with?' };
  if (q.includes('your name') || q.includes('who are you')) return { reply: 'I’m WUK AI by Wuk72. I can save notes and answer a few commands locally. Open-ended AI answers use a provider configured on the private WUK AI backend.' };
  if (q.includes('time')) return { reply: `The time on this device is ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` };
  if (q.includes('date') || q.includes('day is it')) return { reply: `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.` };
  if (q.startsWith('note ') || q.startsWith('remember ')) return { note: raw.replace(/^(note|remember)\s+/i, '').trim() };
  if (q.includes('what can you do') || q === 'help') return { reply: 'I can tell you the date and time, save notes on this phone, and speak answers aloud. Open-ended answers use Gemini through your private backend. If that service is unavailable, I will tell you instead of making up an AI answer.' };
  if (q.includes('offline')) return { reply: 'Offline, you can use local date and time commands, save notes, and review your conversations. Open-ended AI answers require the backend.' };
  return null;
};

// This native module is absent from Expo Go. Catch that case so the rest of the app still works there.
let speechRecognition = null;
try { speechRecognition = require('expo-speech-recognition').ExpoSpeechRecognitionModule; } catch { /* use a development build for voice input */ }

async function writeChatImage(base64, id, mimeType = 'image/jpeg') {
  if (Platform.OS === 'web') {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const uri = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    webImageCache.set(uri, base64);
    return uri;
  }
  if (!IMAGE_CACHE_DIR) throw new Error('Image storage is unavailable on this device.');
  const directory = await FileSystem.getInfoAsync(IMAGE_CACHE_DIR);
  if (!directory.exists) await FileSystem.makeDirectoryAsync(IMAGE_CACHE_DIR, { intermediates: true });
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const uri = `${IMAGE_CACHE_DIR}${id}.${extension}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return uri;
}

async function readChatImage(uri) {
  if (Platform.OS === 'web' && webImageCache.has(uri)) return webImageCache.get(uri);
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Action({ label, onPress, quiet = false, disabled = false, accessibilityLabel }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || label} onPress={onPress} disabled={disabled} style={({ pressed }) => [styles.action, quiet && styles.actionQuiet, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={[styles.actionText, quiet && styles.actionQuietText]}>{label}</Text>
  </Pressable>;
}

export default function App() {
  const [conversations, setConversations] = useState([newConversation()]);
  const [activeId, setActiveId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [notes, setNotes] = useState([]);
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState(null);
  const [imageGenerationMode, setImageGenerationMode] = useState(false);
  const [screen, setScreen] = useState('chat');
  const [backendUrl, setBackendUrl] = useState(DEFAULT_API_URL);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_API_URL);
  const [accessToken, setAccessToken] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const [providers, setProviders] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('auto');
  const [researchMode, setResearchMode] = useState('automatic');
  const [allowFallback, setAllowFallback] = useState(false);
  const [connection, setConnection] = useState('checking');
  const [connectionMessage, setConnectionMessage] = useState('Checking WUK AI service…');
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [speakingId, setSpeakingId] = useState(null);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [matrixEnabled, setMatrixEnabled] = useState(false);
  const [themeMode, setThemeMode] = useState('frost');
  const [storageBytes, setStorageBytes] = useState(0);
  const [tempCacheCount, setTempCacheCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [voiceListening, setVoiceListening] = useState(false);
  const BrowserSpeechRecognition = Platform.OS === 'web' ? (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition) : null;
  const voiceAvailable = Boolean(speechRecognition || BrowserSpeechRecognition);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const { width: windowWidth } = useWindowDimensions();
  const isDesktopWeb = Platform.OS === 'web' && windowWidth >= 1000;
  const browserRecognitionRef = useRef(null);
  const activeIdRef = useRef(null);
  const requestRef = useRef(null);
  const scrollRef = useRef(null);
  const isMounted = useRef(true);

  const activeConversation = useMemo(() => conversations.find(item => item.id === activeId) || conversations[0], [conversations, activeId]);
  const messages = activeConversation?.messages || [];
  const totalMessages = conversations.reduce((total, item) => total + item.messages.length, 0);

  useEffect(() => { activeIdRef.current = activeConversation?.id || null; }, [activeConversation?.id]);

  useEffect(() => {
    isMounted.current = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY) || await AsyncStorage.getItem(LEGACY_STORAGE_KEY) || await AsyncStorage.getItem(OLDER_STORAGE_KEY);
        if (saved) {
          const data = JSON.parse(saved);
          let loaded = Array.isArray(data.conversations) ? data.conversations.filter(item => Array.isArray(item.messages)) : null;
          if (!loaded?.length && Array.isArray(data.messages) && data.messages.length) loaded = [{ id: newId(), title: 'Earlier conversation', updatedAt: new Date().toISOString(), messages: data.messages }];
          if (loaded?.length) setConversations(Platform.OS === 'web' ? loaded.map(conversation => ({ ...conversation, messages: conversation.messages.map(message => message.imageUri?.startsWith('blob:') ? { ...message, imageUri: undefined, imageRemoved: true } : message) })) : loaded);
          if (Array.isArray(data.notes)) setNotes(data.notes);
          if (typeof data.backendUrl === 'string' && data.backendUrl.trim()) {
            const storedUrl = data.backendUrl.trim();
            const migratedUrl = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(storedUrl) ? DEFAULT_API_URL : storedUrl;
            setBackendUrl(migratedUrl); setDraftUrl(migratedUrl);
          }
          if (typeof data.autoSpeak === 'boolean') setAutoSpeak(data.autoSpeak);
          if (['auto', 'gemini', 'openai', 'anthropic', 'groq', 'openrouter', 'cloudflare', 'mistral'].includes(data.selectedProvider)) setSelectedProvider(data.selectedProvider);
          if (['automatic', 'off', 'always'].includes(data.researchMode)) setResearchMode(data.researchMode);
          if (typeof data.allowFallback === 'boolean') setAllowFallback(data.allowFallback);
          if (typeof data.matrixEnabled === 'boolean') setMatrixEnabled(data.matrixEnabled);
          if (data.themeMode === 'frost' || data.themeMode === 'mist') setThemeMode(data.themeMode);
          if (typeof data.activeId === 'string') setActiveId(data.activeId);
        }
      } catch { setBanner('Some saved data could not be read. You can keep using WUK AI and your original data is untouched.'); }
      finally { setHydrated(true); }
    })();
    return () => { isMounted.current = false; requestRef.current?.abort(); Speech.stop(); speechRecognition?.stop?.(); browserRecognitionRef.current?.stop?.(); webImageCache.forEach((_base64, uri) => URL.revokeObjectURL(uri)); webImageCache.clear(); };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const payload = JSON.stringify({ conversations, activeId: activeConversation?.id, notes, backendUrl, autoSpeak, matrixEnabled, themeMode, selectedProvider, researchMode, allowFallback });
    AsyncStorage.setItem(STORAGE_KEY, payload).then(async () => {
      setStorageBytes(utf8ByteLength(payload));
      const keys = await AsyncStorage.getAllKeys();
      const temporaryKeys = keys.filter(key => key.startsWith(TEMP_CACHE_PREFIX)).length;
      const imageDirectory = IMAGE_CACHE_DIR ? await FileSystem.getInfoAsync(IMAGE_CACHE_DIR) : { exists: false };
      const imageCount = imageDirectory.exists ? (await FileSystem.readDirectoryAsync(IMAGE_CACHE_DIR)).length : 0;
      setTempCacheCount(temporaryKeys + imageCount + webImageCache.size);
    }).catch(() => setBanner('Could not save the latest change to local storage.'));
  }, [conversations, activeId, activeConversation?.id, notes, backendUrl, autoSpeak, matrixEnabled, themeMode, selectedProvider, researchMode, allowFallback, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    checkBackend(backendUrl, '').then(result => {
      if (!cancelled) { setConnection('reachable'); setConnectionMessage(result.message); if (result.providers) setProviders(result.providers); }
    }).catch(error => {
      if (!cancelled) { setConnection(error.code === 'NETWORK' || error.code === 'TIMEOUT' ? 'offline' : 'unavailable'); setConnectionMessage(error.message); }
    });
    return () => { cancelled = true; };
  }, [hydrated, backendUrl]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        speechRecognition?.stop?.();
        setVoiceListening(false);
        Speech.stop();
        setSpeakingId(null);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!speechRecognition?.addListener) return undefined;
    const resultSub = speechRecognition.addListener('result', event => {
      const transcript = event.results?.map(result => result.transcript).filter(Boolean).join(' ');
      if (transcript && isMounted.current) setInput(transcript);
    });
    const startSub = speechRecognition.addListener('start', () => isMounted.current && setVoiceListening(true));
    const endSub = speechRecognition.addListener('end', () => isMounted.current && setVoiceListening(false));
    const errorSub = speechRecognition.addListener('error', event => {
      if (!isMounted.current) return;
      setVoiceListening(false);
      setBanner(event.error === 'not-allowed' ? 'Microphone permission was denied. Allow it in Android Settings to use voice input.' : `Voice input stopped: ${event.message || event.error || 'recognition failed'}.`);
    });
    return () => { resultSub.remove(); startSub.remove(); endSub.remove(); errorSub.remove(); speechRecognition.stop(); };
  }, []);

  const updateConversation = useCallback((id, updater) => {
    setConversations(previous => previous.map(item => {
      if (item.id !== id) return item;
      const messagesNext = typeof updater === 'function' ? updater(item.messages) : updater;
      const firstUser = messagesNext.find(message => message.role === 'user');
      return { ...item, messages: messagesNext, title: item.title === 'New conversation' && firstUser ? firstUser.text.slice(0, 42) : item.title, updatedAt: new Date().toISOString() };
    }));
  }, []);

  const updateDelivery = useCallback((id, messageId, delivery) => updateConversation(id, list => list.map(message => message.id === messageId ? { ...message, delivery } : message)), [updateConversation]);

  function addAssistant(id, text, imageUri = null, metadata = {}) {
    updateConversation(id, list => [...list, { id: newId(), role: 'assistant', text, time: new Date().toISOString(), ...(imageUri ? { imageUri } : {}), ...metadata }]);
  }

  async function startRequest(id, transcript, userMessageId, media = {}) {
    setBusy(true);
    setBanner('');
    setConnection('checking');
    setConnectionMessage('Waking up WUK AI…');
    const controller = new AbortController();
    requestRef.current = controller;
    const userIndex = transcript.findIndex(message => message.id === userMessageId);
    const context = transcript.slice(0, userIndex + 1);
    try {
      let reply;
      if (media.generateImage) {
        const result = await generateImage(backendUrl, accessToken, context.at(-1)?.text, controller.signal, selectedProvider, allowFallback);
        const imageUri = await writeChatImage(result.image.data, newId(), result.image.mimeType);
        reply = result.reply;
        if (!isMounted.current) return;
        updateDelivery(id, userMessageId, 'sent');
        addAssistant(id, reply, imageUri, { provider: result.provider, providerName: result.providerName, model: result.model, fallback: result.fallback });
      } else if (media.imageBase64) {
        const result = await askAboutImage(backendUrl, accessToken, context.at(-1)?.text || 'Describe this image.', media.imageBase64, media.mimeType || 'image/jpeg', controller.signal, selectedProvider, allowFallback || selectedProvider === 'auto');
        reply = result.reply;
        if (!isMounted.current) return;
        updateDelivery(id, userMessageId, 'sent');
        addAssistant(id, reply, null, { provider: result.provider, providerName: result.providerName, model: result.model, fallback: result.fallback });
      } else {
        const prompt = context.at(-1)?.text || '';
        const research = researchMode === 'always' || (researchMode === 'automatic' && needsFreshResearch(prompt));
        const result = await sendToBackend(backendUrl, accessToken, context, controller.signal, { provider: selectedProvider, research, allowFallback });
        reply = result.reply;
        if (!isMounted.current) return;
        updateDelivery(id, userMessageId, 'sent');
        addAssistant(id, reply, null, { provider: result.provider, providerName: result.providerName, model: result.model, fallback: result.fallback, searched: result.searched, citations: result.citations });
        setConnectionMessage(`${result.providerName}${result.fallback ? ' · fallback used' : ''}${result.searched ? ' · web research' : ' · ready'}`);
      }
      if (!isMounted.current) return;
      setConnection('online');
      setConnectionMessage('AI provider responded successfully');
      if (autoSpeak) speak({ id: `reply-${newId()}`, text: reply });
    } catch (error) {
      if (!isMounted.current) return;
      updateDelivery(id, userMessageId, 'failed');
      setConnection(error.name === 'AbortError' ? 'reachable' : error.code === 'NETWORK' || error.code === 'TIMEOUT' ? 'offline' : 'unavailable');
      setConnectionMessage(error.name === 'AbortError' ? 'Stopped waiting for a response' : error.code === 'NETWORK' ? 'Service unavailable' : error.message);
      setBanner(error.name === 'AbortError' ? 'Stopped waiting for this response. The backend may still finish processing it. Tap Retry if you want to send the message again.' : error.message);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (isMounted.current) setBusy(false);
    }
  }

  async function chooseImage() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, base64: true, allowsEditing: false });
      if (result.canceled) return;
      const asset = result.assets?.[0];
      if (!asset?.base64) { setBanner('Could not read that photo. Choose another image and try again.'); return; }
      if (asset.base64.length > MAX_IMAGE_BASE64_LENGTH) { Alert.alert('Photo is too large', 'Choose a smaller or compressed image. WUK AI limits photo uploads to about 3.5 MB.'); return; }
      setPendingImage({ uri: asset.uri, base64: asset.base64, mimeType: 'image/jpeg' });
      setImageGenerationMode(false);
      setBanner('Photo selected. WUK AI will use a configured vision provider.');
    } catch {
      setBanner('Could not open your photos. Try again or check Android permissions.');
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && !pendingImage) || busy || !activeConversation) return;
    if (imageGenerationMode && !text) { setBanner('Describe the image you want to create first.'); return; }
    let imageUri = null;
    if (pendingImage) {
      try { imageUri = await writeChatImage(pendingImage.base64, newId()); }
      catch { setBanner('Could not keep this photo on your phone. Check free storage and try again.'); return; }
    }
    const id = activeConversation.id;
    const time = new Date().toISOString();
    const userMessage = { id: newId(), role: 'user', text: text || 'What is in this image?', time, delivery: 'pending', ...(imageUri ? { imageUri, imageMimeType: 'image/jpeg' } : {}), ...(imageGenerationMode ? { imageGeneration: true } : {}) };
    const nextMessages = [...messages, userMessage];
    setInput('');
    setPendingImage(null);
    setImageGenerationMode(false);
    updateConversation(id, nextMessages);
    const local = !imageUri && !imageGenerationMode ? localCommand(text) : null;
    if (local?.note !== undefined) {
      updateDelivery(id, userMessage.id, 'sent');
      if (local.note) {
        setNotes(previous => [{ id: newId(), text: local.note, createdAt: time }, ...previous]);
        addAssistant(id, `Saved on this phone: “${local.note}”`);
      } else addAssistant(id, 'Tell me what to save, for example: “note call the dentist”.');
      return;
    }
    if (local?.reply) {
      updateDelivery(id, userMessage.id, 'sent');
      addAssistant(id, local.reply);
      if (autoSpeak) speak({ id: `reply-${newId()}`, text: local.reply });
      return;
    }
    if (!accessToken.trim()) {
      updateDelivery(id, userMessage.id, 'failed');
      setConnection('reachable');
      setConnectionMessage('Backend is up · access token needed');
      setBanner('This message is saved on your phone but wasn’t sent. Add the backend access token in Settings, then tap Retry.');
      return;
    }
    await startRequest(id, nextMessages, userMessage.id, {
      imageBase64: pendingImage?.base64,
      mimeType: pendingImage?.mimeType,
      generateImage: imageGenerationMode,
    });
  }

  async function retryMessage(message) {
    if (busy || !activeConversation || !message) return;
    const index = messages.findIndex(item => item.id === message.id);
    if (index === -1 || message.role !== 'user') return;
    if (!accessToken.trim()) { setBanner('Add the backend access token in Settings, then retry this message.'); return; }
    const id = activeConversation.id;
    const transcript = messages.slice(0, index + 1).map(item => ({ ...item, delivery: item.id === message.id ? 'pending' : item.delivery }));
    updateConversation(id, list => [...list.slice(0, index), { ...list[index], delivery: 'pending' }, ...list.slice(index + 1)]);
    let imageBase64;
    if (message.imageUri && !message.imageGeneration) {
      try { imageBase64 = await readChatImage(message.imageUri); }
      catch { setBanner('The cached photo is no longer available on this phone. Attach it again to retry.'); updateDelivery(id, message.id, 'failed'); return; }
    }
    await startRequest(id, transcript, message.id, { imageBase64, mimeType: message.imageMimeType || 'image/jpeg', generateImage: message.imageGeneration === true });
  }

  function newChat() {
    if (busy) { Alert.alert('Response in progress', 'Stop the current response before starting a new conversation.'); return; }
    const conversation = newConversation();
    setConversations(previous => [conversation, ...previous]);
    setActiveId(conversation.id);
    setVisibleCount(PAGE_SIZE);
    setScreen('chat');
    setBanner('');
    stopSpeaking();
  }

  function deleteConversation(id) {
    Alert.alert('Delete conversation?', 'This permanently removes only this conversation from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        const deleted = conversations.find(item => item.id === id);
        deleted?.messages.forEach(message => { if (message.imageUri && webImageCache.has(message.imageUri)) { URL.revokeObjectURL(message.imageUri); webImageCache.delete(message.imageUri); } });
        const remaining = conversations.filter(item => item.id !== id);
        if (!remaining.length) remaining.push(newConversation());
        setConversations(remaining);
        if (activeIdRef.current === id) setActiveId(remaining[0].id);
      } },
    ]);
  }

  function clearHistory() {
    Alert.alert('Clear all conversations?', 'Notes will stay on this phone. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear conversations', style: 'destructive', onPress: () => {
        webImageCache.forEach((_base64, uri) => URL.revokeObjectURL(uri)); webImageCache.clear();
        const conversation = newConversation();
        setConversations([conversation]); setActiveId(conversation.id); setBanner(''); setScreen('chat');
      } },
    ]);
  }

  function speak(message) {
    Speech.stop();
    setSpeakingId(message.id);
    Speech.speak(message.text, {
      language: 'en-US', rate: 0.96,
      onDone: () => setSpeakingId(null), onStopped: () => setSpeakingId(null),
      onError: () => { setSpeakingId(null); setBanner('Text-to-speech is unavailable. Check that an Android speech engine is installed.'); },
    });
  }
  function stopSpeaking() { Speech.stop(); setSpeakingId(null); }

  async function toggleListening() {
    if (!speechRecognition && BrowserSpeechRecognition) {
      if (voiceListening) { browserRecognitionRef.current?.stop(); setVoiceListening(false); return; }
      try {
        const recognition = new BrowserSpeechRecognition();
        browserRecognitionRef.current = recognition;
        recognition.lang = 'en-US'; recognition.interimResults = true; recognition.continuous = false;
        recognition.onresult = event => setInput(Array.from(event.results).map(result => result[0]?.transcript || '').join(' '));
        recognition.onstart = () => setVoiceListening(true);
        recognition.onend = () => setVoiceListening(false);
        recognition.onerror = event => { setVoiceListening(false); setBanner(`Browser voice input stopped: ${event.error || 'recognition failed'}.`); };
        setInput(''); recognition.start();
      } catch { setVoiceListening(false); setBanner('Browser voice input is unavailable. Check microphone permission and browser support.'); }
      return;
    }
    if (!speechRecognition) {
      Alert.alert('Voice input needs a development build', 'Expo Go does not include speech recognition. Build and install the WUK AI development app, then try again.');
      return;
    }
    if (voiceListening) { speechRecognition.stop(); setVoiceListening(false); return; }
    const beginRecognition = async () => {
      try {
        const permission = await speechRecognition.requestPermissionsAsync();
        if (!permission.granted) { setBanner('Microphone or speech recognition permission was denied. You can still type messages.'); return; }
        setInput('');
        speechRecognition.start({ lang: 'en-US', interimResults: true, continuous: false });
      } catch { setVoiceListening(false); setBanner('Speech recognition is unavailable on this device. Check Google speech services and microphone permission.'); }
    };
    Alert.alert('Use voice input?', 'WUK AI uses the microphone only while you tap this control. Speech becomes editable text; no audio recording is saved.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Continue', onPress: beginRecognition },
    ]);
  }

  async function testConnection() {
    setChecking(true); setConnection('checking'); setConnectionMessage('Checking backend and configured providers…'); setBanner('');
    try {
      const result = await checkBackend(draftUrl, draftToken);
      setConnection('reachable');
      setConnectionMessage(result.message);
      if (result.providers) setProviders(result.providers);
      setBanner(result.message);
    } catch (error) {
      setConnection(error.code === 'NETWORK' || error.code === 'TIMEOUT' ? 'offline' : 'unavailable');
      setConnectionMessage(error.message); setBanner(error.message);
    } finally { setChecking(false); }
  }

  function saveConnection() {
    const url = draftUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) { Alert.alert('Check the server address', 'Enter a complete address beginning with https:// or http://.'); return; }
    setBackendUrl(url); setAccessToken(draftToken.trim()); setSettingsOpen(false);
    setConnection('reachable'); setConnectionMessage(draftToken.trim() ? 'Connection saved · run a test to check configured providers' : 'Backend address saved · add access token to use AI');
    setBanner('');
  }

  function deleteNote(id) { setNotes(previous => previous.filter(note => note.id !== id)); }
  function clearTemporaryCache() {
    Alert.alert('Clear temporary cache?', 'Notes and conversation text will stay. Cached chat images will be removed from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear cache', style: 'destructive', onPress: async () => {
        try {
          if (Platform.OS === 'web') {
            webImageCache.forEach((_base64, uri) => URL.revokeObjectURL(uri));
            webImageCache.clear();
          }
          const keys = await AsyncStorage.getAllKeys();
          const cacheKeys = keys.filter(key => key.startsWith(TEMP_CACHE_PREFIX));
          if (cacheKeys.length) await AsyncStorage.multiRemove(cacheKeys);
          if (IMAGE_CACHE_DIR) await FileSystem.deleteAsync(IMAGE_CACHE_DIR, { idempotent: true });
          setConversations(previous => previous.map(conversation => ({ ...conversation, messages: conversation.messages.map(message => {
            if (!message.imageUri) return message;
            const rest = { ...message };
            delete rest.imageUri;
            delete rest.imageMimeType;
            return { ...rest, imageRemoved: true };
          }) })));
          setTempCacheCount(0); Alert.alert('Cache cleared', 'Notes and conversation text were kept. Cached chat images were removed.');
        } catch { Alert.alert('Could not clear cache', 'Your notes and conversations were not changed.'); }
      } },
    ]);
  }

  const pageBackground = themeMode === 'mist' ? c.paleMist : c.background;

  async function exportConversation() {
    const conversation = activeConversation;
    if (!conversation) { setBanner('There is no conversation to export.'); return; }
    const content = conversation.messages.map(message => `[${new Date(message.time).toLocaleString()}] ${message.role === 'user' ? 'You' : 'WUK AI'}\n${message.text || ''}`).join('\n\n');
    const safeName = (conversation.title || 'conversation').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '').slice(0, 48) || 'conversation';
    try {
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `wuk-ai-${safeName}.txt`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const path = `${FileSystem.cacheDirectory}wuk-ai-${safeName}.txt`;
        await FileSystem.writeAsStringAsync(path, content);
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path, { mimeType: 'text/plain', dialogTitle: 'Export WUK AI conversation' });
        else { await Clipboard.setStringAsync(content); setBanner('File sharing is unavailable. Conversation copied to clipboard instead.'); return; }
      }
      setBanner('Conversation export is ready.');
    } catch { setBanner('Could not export this conversation. Try again.'); }
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: pageBackground, paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0 }]}>
      <StatusBar barStyle="dark-content" backgroundColor={pageBackground} />
      <MatrixRain enabled={matrixEnabled} />
      <View style={[styles.appShell, isDesktopWeb && styles.desktopShell]}>
      {isDesktopWeb ? <View style={styles.desktopSidebar}>
        <View style={styles.sidebarBrand}><View style={styles.logo}><Text style={styles.logoText}>W</Text></View><View><Text style={styles.brand}>WUK AI</Text><Text style={styles.subtitle}>BY WUK72</Text></View></View>
        <Action label="＋ NEW CHAT" onPress={newChat} />
        <TextInput value={historySearch} onChangeText={setHistorySearch} placeholder="Search conversations" placeholderTextColor={c.secondaryText} style={styles.sidebarSearch} accessibilityLabel="Search conversations" />
        <ScrollView style={styles.sidebarList} contentContainerStyle={{ gap: 5 }}>
          {[...conversations].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).filter(item => `${item.title} ${item.messages.filter(m => m.role === 'user').map(m => m.text).join(' ')}`.toLowerCase().includes(historySearch.toLowerCase())).map(item => <Pressable key={item.id} onPress={() => { setActiveId(item.id); setScreen('chat'); setVisibleCount(PAGE_SIZE); setBanner(''); }} style={[styles.sidebarItem, item.id === activeId && styles.sidebarItemActive]}><Text numberOfLines={1} style={styles.sidebarItemTitle}>{item.title}</Text><Text numberOfLines={1} style={styles.sidebarItemSummary}>{item.messages.filter(m => m.role === 'user').at(-1)?.text || 'No messages yet'}</Text></Pressable>)}
        </ScrollView>
        {['history', 'notes', 'connections', 'settings'].map(key => <Pressable key={key} accessibilityRole="button" onPress={() => key === 'settings' ? (setDraftUrl(backendUrl), setDraftToken(accessToken), setSettingsOpen(true)) : setScreen(key)} style={styles.sidebarNav}><Text style={styles.sidebarNavText}>{({ history: 'Conversations', notes: 'Notes', connections: 'Connections', settings: 'Settings' })[key]}</Text></Pressable>)}
      </View> : null}
      <KeyboardAvoidingView style={[styles.container, isDesktopWeb && styles.desktopMain]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { backgroundColor: pageBackground }]}>
          <View style={styles.brandRow}>
            <View style={styles.logo}><Text style={styles.logoText}>W</Text></View>
            <View style={{ flexShrink: 1 }}><Text style={styles.brand}>WUK AI</Text><Text style={styles.subtitle}>BY WUK72 · PERSONAL ASSISTANT</Text></View>
          </View>
          <View style={styles.headerActions}>
            <Action label="☰" quiet accessibilityLabel="Open navigation menu" onPress={() => setNavigationOpen(true)} />
            <Action label="SETTINGS" quiet onPress={() => { setDraftUrl(backendUrl); setDraftToken(accessToken); setSettingsOpen(true); }} />
          </View>
        </View>

        {screen === 'chat' ? <>
          <ScrollView ref={scrollRef} style={styles.content} contentContainerStyle={styles.chatContent} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
            {messages.length <= 1 ? <View style={styles.welcomeCard}>
              <View style={styles.welcomeMark}><Text style={styles.welcomeMarkText}>W</Text></View>
              <Text style={styles.welcomeTitle}>What can I help with?</Text>
              <Text style={styles.welcomeCopy}>A personal assistant by Wuk72. Your notes and conversations are saved on this device.</Text>
              <View style={styles.promptGrid}>
                {['Explain a complex idea simply', 'Help me plan my day', 'What time is it?', 'Save a note for later'].map(prompt => <Pressable key={prompt} onPress={() => setInput(prompt.startsWith('Save') ? 'note ' : prompt)} style={({ pressed }) => [styles.promptCard, pressed && styles.pressed]}><Text style={styles.promptText}>{prompt}</Text><Text style={styles.promptArrow}>↗</Text></Pressable>)}
              </View>
            </View> : null}
            {messages.length > visibleCount && <Action label={`LOAD ${Math.min(PAGE_SIZE, messages.length - visibleCount)} OLDER MESSAGES`} quiet onPress={() => setVisibleCount(count => count + PAGE_SIZE)} />}
            {messages.slice(-visibleCount).map(message => <View key={message.id} style={[styles.message, message.role === 'user' ? styles.userMessage : styles.assistantMessage]}>
              <View style={styles.messageHeader}><View style={styles.speakerMark}><Text style={styles.speakerMarkText}>{message.role === 'user' ? 'Y' : 'W'}</Text></View><Text style={[styles.messageRole, message.role === 'user' && styles.userMessageRole]}>{message.role === 'user' ? 'YOU' : message.providerName ? `WUK AI · ${message.providerName.toUpperCase()}${message.fallback ? ' · FALLBACK' : ''}` : 'WUK AI'}</Text><Text style={[styles.messageTime, message.role === 'user' && styles.userMessageTime]}>{formatTime(message.time)}</Text></View>
              {message.imageUri ? <Image source={{ uri: message.imageUri }} accessibilityLabel={message.role === 'user' ? 'Photo attached to the question' : 'Image generated by Gemini'} resizeMode="contain" style={styles.chatImage} /> : message.imageRemoved ? <Text style={styles.imageRemoved}>Image cleared from temporary storage.</Text> : null}
      {message.role === 'assistant' ? <MarkdownMessage text={message.text} onCopyCode={async code => { await Clipboard.setStringAsync(code); setBanner('Code copied to clipboard.'); }} /> : <Text selectable style={styles.messageText}>{message.text}</Text>}
              {message.citations?.length ? <View style={styles.sourcesBlock}><Text style={styles.sourcesTitle}>SOURCES</Text>{message.citations.map((citation, index) => <Pressable key={`${citation.url}-${index}`} accessibilityRole="link" onPress={() => Linking.openURL(citation.url)} style={styles.sourceLink}><Text numberOfLines={2} style={styles.sourceText}>{index + 1}. {citation.title || citation.publisher || citation.url}</Text><Text numberOfLines={1} style={styles.sourceUrl}>{citation.publisher || citation.url}{citation.retrievedAt ? ` · retrieved ${new Date(citation.retrievedAt).toLocaleDateString()}` : ''}</Text></Pressable>)}</View> : message.searched ? <Text style={styles.fieldHint}>Web research was requested, but this provider returned no source links.</Text> : null}
              {message.delivery === 'failed' && <View style={styles.deliveryRow}><Text style={styles.failedText}>NOT SENT</Text><Pressable accessibilityRole="button" onPress={() => retryMessage(message)} disabled={busy} style={styles.retryButton}><Text style={styles.retryText}>RETRY ↻</Text></Pressable></View>}
              {message.role === 'assistant' && <View style={styles.messageTools}>
                <Pressable accessibilityRole="button" accessibilityLabel="Copy response" onPress={async () => { await Clipboard.setStringAsync(message.text); setBanner('Response copied to clipboard.'); }} style={styles.toolButton}><Text style={styles.toolText}>COPY</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={speakingId === message.id ? 'Stop speaking' : 'Speak response'} onPress={() => speakingId === message.id ? stopSpeaking() : speak(message)} style={styles.toolButton}><Text style={styles.toolText}>{speakingId === message.id ? 'STOP VOICE' : 'SPEAK'}</Text></Pressable>
              </View>}
            </View>)}
            {busy && <View style={styles.typing}><ActivityIndicator size="small" color={c.deepBlue} /><Text style={styles.typingText}>WUK AI is waking up or thinking…</Text></View>}
          </ScrollView>
          {banner ? <View accessibilityRole="alert" style={[styles.banner, connection === 'online' && styles.successBanner]}><Text style={styles.bannerText}>{banner}</Text><Pressable accessibilityLabel="Dismiss message" onPress={() => setBanner('')} hitSlop={10}><Text style={styles.bannerClose}>×</Text></Pressable></View> : null}
          <View style={[styles.composerWrap, { backgroundColor: pageBackground }]}>
            {pendingImage ? <View style={styles.selectedImageRow}><Image source={{ uri: pendingImage.uri }} style={styles.selectedImage} accessibilityLabel="Selected photo preview" /><View style={{ flex: 1 }}><Text style={styles.selectedImageTitle}>PHOTO READY</Text><Text style={styles.selectedImageHint}>Sent only when you send your question</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Remove selected photo" onPress={() => setPendingImage(null)} style={styles.removeImage}><Text style={styles.bannerClose}>×</Text></Pressable></View> : null}
            <View style={styles.mediaActions}>
              <Pressable accessibilityRole="button" accessibilityLabel="Choose a photo to ask Gemini about" disabled={busy} onPress={chooseImage} style={[styles.mediaAction, busy && styles.disabled]}><Text style={styles.mediaActionText}>＋ PHOTO</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityState={{ selected: imageGenerationMode }} disabled={busy} onPress={() => { setImageGenerationMode(value => !value); setPendingImage(null); setBanner(''); }} style={[styles.mediaAction, imageGenerationMode && styles.mediaActionActive, busy && styles.disabled]}><Text style={[styles.mediaActionText, imageGenerationMode && styles.mediaActionActiveText]}>{imageGenerationMode ? 'IMAGE MODE ON' : 'CREATE IMAGE'}</Text></Pressable>
              {imageGenerationMode ? <Text style={styles.imageModeHint}>Describe the image, then send.</Text> : null}
            </View>
            <View style={styles.composer}>
              <Pressable accessibilityRole="button" accessibilityLabel={voiceListening ? 'Stop voice input' : 'Start voice input'} onPress={toggleListening} style={[styles.voiceButton, voiceListening && styles.voiceActive]}><Text style={[styles.voiceText, voiceListening && styles.voiceTextActive]}>{voiceListening ? '■' : 'MIC'}</Text></Pressable>
              <TextInput value={input} onChangeText={setInput} onSubmitEditing={sendMessage} placeholder={voiceListening ? 'Listening… edit transcript before sending' : 'Message WUK AI…'} placeholderTextColor={c.secondaryText} style={styles.input} returnKeyType="send" multiline maxLength={2000} editable={!busy} accessibilityLabel="Message WUK AI" />
              {busy ? <Pressable accessibilityRole="button" accessibilityLabel="Stop waiting for response" onPress={() => requestRef.current?.abort()} style={styles.stopButton}><Text style={styles.stopText}>CANCEL</Text></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={imageGenerationMode ? 'Generate image' : pendingImage ? 'Ask Gemini about selected image' : 'Send message'} onPress={sendMessage} disabled={!input.trim() && !pendingImage} style={[styles.sendButton, !input.trim() && !pendingImage && styles.disabled]}><Text style={styles.sendText}>↑</Text></Pressable>}
            </View>
            <Text style={styles.composerHint}>{voiceAvailable ? 'VOICE INPUT READY' : 'VOICE INPUT NEEDS A DEVELOPMENT BUILD'}  ·  LOCAL NOTES STAY ON THIS PHONE</Text>
          </View>
        </> : screen === 'history' ? <ScrollView style={styles.content} contentContainerStyle={styles.pageContent}>
          <View style={styles.pageHeadingRow}><View><Text style={styles.pageEyebrow}>YOUR LIBRARY</Text><Text style={styles.pageTitle}>Conversations</Text></View></View>
          <View style={styles.historyActions}><Action label="EXPORT ACTIVE CHAT" quiet onPress={exportConversation} /><Action label="＋ NEW" onPress={newChat} /></View>
          <TextInput value={historySearch} onChangeText={setHistorySearch} placeholder="Search conversations" placeholderTextColor={c.secondaryText} style={styles.fieldInput} accessibilityLabel="Search conversations" />
          {!conversations.length ? <Text style={styles.emptyCopy}>Your saved conversations will appear here.</Text> : [...conversations].filter(item => `${item.title} ${item.messages.filter(m => m.role === 'user').map(m => m.text).join(' ')}`.toLowerCase().includes(historySearch.toLowerCase())).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(item => <Pressable key={item.id} onPress={() => { setActiveId(item.id); setScreen('chat'); setVisibleCount(PAGE_SIZE); setBanner(''); }} style={({ pressed }) => [styles.conversationCard, item.id === activeId && styles.currentConversation, pressed && styles.pressed]}>
            <View style={styles.conversationIcon}><Text style={styles.conversationIconText}>W</Text></View><View style={styles.conversationInfo}><Text numberOfLines={1} style={styles.conversationTitle}>{item.title}</Text><Text numberOfLines={1} style={styles.conversationSummary}>{item.messages.filter(m => m.role === 'user').at(-1)?.text || 'No messages yet'}</Text><Text style={styles.conversationMeta}>{item.messages.length} messages · {new Date(item.updatedAt).toLocaleDateString()}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Delete conversation" onPress={() => deleteConversation(item.id)} hitSlop={12} style={styles.deleteConversation}><Text style={styles.deleteConversationText}>×</Text></Pressable>
          </Pressable>)}
        </ScrollView> : screen === 'notes' ? <ScrollView style={styles.content} contentContainerStyle={styles.pageContent}>
          <Text style={styles.pageEyebrow}>ON-DEVICE MEMORY</Text><Text style={styles.pageTitle}>Your notes</Text><Text style={styles.pageDescription}>Notes stay on this phone and are never automatically sent to Gemini.</Text>
          {notes.length === 0 ? <View style={styles.emptyCard}><Text style={styles.emptyCopy}>No notes saved yet. In Chat, type “note followed by your note”.</Text></View> : notes.map(note => <View key={note.id} style={styles.noteCard}><Text style={styles.noteText}>{note.text}</Text><View style={styles.noteFooter}><Text style={styles.noteDate}>{new Date(note.createdAt).toLocaleString()}</Text><Pressable accessibilityRole="button" onPress={() => deleteNote(note.id)} style={styles.noteDelete}><Text style={styles.noteDeleteText}>DELETE</Text></Pressable></View></View>)}
        </ScrollView> : screen === 'connections' ? <ScrollView style={styles.content} contentContainerStyle={styles.pageContent}>
          <Text style={styles.pageEyebrow}>AI PROVIDER ACCESS</Text><Text style={styles.pageTitle}>Connections</Text>
          <Text style={styles.pageDescription}>Choose a provider configured by the WUK AI server administrator. API keys stay on the server; each provider may charge separately.</Text>
          <View style={styles.sectionCard}><Text style={styles.cardEyebrow}>SERVER-MANAGED PROVIDERS</Text><Pressable accessibilityRole="radio" accessibilityState={{ selected: selectedProvider === 'auto' }} onPress={() => setSelectedProvider('auto')} style={[styles.providerChoice, selectedProvider === 'auto' && styles.providerChoiceSelected]}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Auto · Best available</Text><Text style={styles.settingDescription}>Chooses a provider that supports the task and tries another compatible provider after a rate limit or outage.</Text></View><Text style={styles.providerCheck}>{selectedProvider === 'auto' ? '✓' : ''}</Text></Pressable>{providers.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ selected: selectedProvider === item.id, disabled: !item.configured }} disabled={!item.configured} onPress={() => setSelectedProvider(item.id)} style={[styles.providerChoice, selectedProvider === item.id && styles.providerChoiceSelected, !item.configured && styles.disabled]}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>{item.name}{item.model ? ` · ${item.model}` : ''}</Text><Text style={styles.settingDescription}>{item.configured ? `Available · ${item.capabilities.join(', ')}` : 'Not configured on backend'}</Text></View><Text style={styles.providerCheck}>{selectedProvider === item.id ? '✓' : ''}</Text></Pressable>)}<Text style={styles.dataFootnote}>Provider credentials are stored on your backend and shared by this installation. They are API credentials, not your Gemini/Claude/ChatGPT consumer subscriptions. Providers may charge separately; automatic fallback can send the same request to another provider.</Text></View>
          <Pressable accessibilityRole="button" onPress={() => setResearchMode(value => value === 'automatic' ? 'off' : value === 'off' ? 'always' : 'automatic')} style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Web research · {researchMode === 'automatic' ? 'Automatic' : researchMode === 'always' ? 'Always' : 'Off'}</Text><Text style={styles.settingDescription}>{researchMode === 'automatic' ? 'Search likely current topics such as news, prices, and current docs.' : researchMode === 'always' ? 'Use the selected provider’s search tool for every text question.' : 'Do not request web search.'}</Text></View><Text style={styles.settingChevron}>↻</Text></Pressable>
          <View style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Allow provider fallback</Text><Text style={styles.settingDescription}>Auto always tries compatible alternatives. With a specific provider selected, this can retry on another compatible provider after a quota or service failure.</Text></View><SwitchRow value={allowFallback} onValueChange={setAllowFallback} label="Allow fallback to another provider when selecting a specific provider" /></View>
          <View style={styles.aboutCard}><Text style={styles.aboutTitle}>Connection status</Text><Text style={styles.settingDescription}>{connectionMessage}</Text><Text style={styles.settingUrl}>{backendUrl}</Text><Action label="CONFIGURE BACKEND ACCESS" quiet onPress={() => { setDraftUrl(backendUrl); setDraftToken(accessToken); setSettingsOpen(true); }} /></View>
          <Text style={styles.smallHint}>Personal OAuth accounts, a per-user credential vault, and ChatGPT plan-sharing authorization are not available in this project yet. OpenAI partner eligibility is required for using a ChatGPT plan in a third-party app.</Text>
        </ScrollView> : <ScrollView style={styles.content} contentContainerStyle={styles.pageContent}>
          <Text style={styles.pageEyebrow}>PREFERENCES & DIAGNOSTICS</Text><Text style={styles.pageTitle}>Settings</Text>
          <Pressable onPress={() => setScreen('connections')} style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>AI providers & web research</Text><Text style={styles.settingDescription}>{providers.filter(item => item.configured).map(item => item.name).join(', ') || 'Check server connection to discover available providers'} · selected: {selectedProvider === 'auto' ? 'Auto · Best available' : providers.find(item => item.id === selectedProvider)?.name || selectedProvider}</Text></View><Text style={styles.settingChevron}>›</Text></Pressable>
          <View style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Theme · {themeMode === 'frost' ? 'WUK Frost' : 'Pale Mist'}</Text><Text style={styles.settingDescription}>Switch between the two WUK blue palette backgrounds.</Text></View><SwitchRow value={themeMode === 'mist'} onValueChange={value => setThemeMode(value ? 'mist' : 'frost')} label="Switch between WUK Frost and Pale Mist themes" /></View>
          <View style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Speak new responses</Text><Text style={styles.settingDescription}>Use the Android text-to-speech engine when replies arrive.</Text></View><SwitchRow value={autoSpeak} onValueChange={setAutoSpeak} label="Toggle spoken responses" /></View>
          <View style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Matrix Rain</Text><Text style={styles.settingDescription}>A subtle moving background. Off by default to save battery.</Text></View><SwitchRow value={matrixEnabled} onValueChange={setMatrixEnabled} label="Toggle Matrix Rain" /></View>
          <View style={styles.sectionCard}><Text style={styles.cardEyebrow}>LOCAL DATA</Text><DataRow label="Conversations" value={`${conversations.length}`} /><DataRow label="Messages" value={`${totalMessages}`} /><DataRow label="Notes" value={`${notes.length}`} /><DataRow label="Saved data estimate" value={formatBytes(storageBytes)} /><DataRow label="Temporary cache items (including images)" value={`${tempCacheCount}`} /><Text style={styles.dataFootnote}>Saved data estimate covers text/settings JSON; selected and generated image files use temporary device cache. Clearing cache removes those local image files but keeps conversation text. WUK AI does not save audio recordings.</Text></View>
          <Action label="CLEAR TEMPORARY CACHE" quiet onPress={clearTemporaryCache} />
          <Action label="CLEAR ALL CONVERSATIONS" quiet onPress={clearHistory} />
          <View style={styles.aboutCard}><Text style={styles.aboutTitle}>WUK AI <Text style={styles.aboutBrand}>by Wuk72</Text></Text><Text style={styles.settingDescription}>Version 1.0.0 · Expo SDK 57</Text><Text style={styles.settingDescription}>No notes or conversation history are uploaded unless you choose to send a message to the AI backend.</Text></View>
          <Text style={styles.smallHint}>{voiceAvailable ? 'Speech recognition module available.' : 'Speech-to-text requires a WUK AI development build. Expo Go supports the rest of the app.'} Text-to-speech works with Expo Go.</Text>
        </ScrollView>}

      </KeyboardAvoidingView>
      </View>

      <Modal visible={navigationOpen} transparent animationType="fade" onRequestClose={() => setNavigationOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNavigationOpen(false)}>
          <View style={styles.navigationMenu}>
            <Text style={styles.pageEyebrow}>WUK AI · NAVIGATION</Text>
            {[
              ['chat', 'Chat'], ['history', 'Conversations'], ['notes', 'Notes'], ['connections', 'Connections'], ['settings', 'Settings'],
            ].map(([key, label]) => <Pressable key={key} accessibilityRole="button" onPress={() => { setScreen(key); setNavigationOpen(false); }} style={styles.navigationItem}><Text style={styles.navigationItemText}>{label}</Text><Text style={styles.settingChevron}>›</Text></Pressable>)}
            <View style={styles.modalActions}><Action label="＋ NEW CHAT" onPress={() => { setNavigationOpen(false); newChat(); }} /><Action label="CLOSE" quiet onPress={() => setNavigationOpen(false)} /></View>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}><ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled"><View style={styles.settingsModal}>
          <Text style={styles.pageEyebrow}>WUK72 · PRIVATE CONNECTION</Text><Text style={styles.modalTitle}>Backend connection</Text><Text style={styles.modalDescription}>The app calls your Node backend. Provider API keys stay in the server environment. The backend access token is kept only in app memory for this session.</Text>
          <Text style={styles.fieldLabel}>BACKEND URL</Text><TextInput value={draftUrl} onChangeText={setDraftUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://wuk-ai.onrender.com" placeholderTextColor={c.secondaryText} style={styles.fieldInput} />
          <Text style={styles.fieldLabel}>BACKEND ACCESS TOKEN</Text><TextInput value={draftToken} onChangeText={setDraftToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Enter token from backend environment" placeholderTextColor={c.secondaryText} style={styles.fieldInput} />
          <Text style={styles.fieldHint}>Health check proves the service is reachable. The authenticated status check reports server-configured providers. The token is not saved to chat history or local storage.</Text>
          <View style={styles.modalActions}><Action label="CANCEL" quiet onPress={() => setSettingsOpen(false)} /><Action label={checking ? 'CHECKING…' : 'TEST CONNECTION'} quiet disabled={checking} onPress={testConnection} /></View>
          <View style={styles.modalActions}><Action label="SAVE CONNECTION" onPress={saveConnection} /><Action label="OPEN HEALTH" quiet onPress={() => Linking.openURL(`${draftUrl.trim().replace(/\/+$/, '')}/health`)} /></View>
          {checking ? <View style={styles.checkingRow}><ActivityIndicator color={c.deepBlue} /><Text style={styles.fieldHint}>Render may need a moment to wake up.</Text></View> : null}
        </View></ScrollView></View>
      </Modal>
    </SafeAreaView>
  );
}

function SwitchRow({ value, onValueChange, label }) {
  return <Pressable accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }} onPress={() => onValueChange(!value)} style={[styles.switchTrack, value && styles.switchTrackOn]}><View style={[styles.switchThumb, value && styles.switchThumbOn]} /></Pressable>;
}
function DataRow({ label, value }) { return <View style={styles.dataRow}><Text style={styles.dataLabel}>{label}</Text><Text style={styles.dataValue}>{value}</Text></View>; }
function utf8ByteLength(value) { let bytes = 0; for (const character of value) { const point = character.codePointAt(0); bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; } return bytes; }
function formatBytes(bytes) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.background }, container: { flex: 1, backgroundColor: 'transparent' },
  appShell: { flex: 1 }, desktopShell: { flexDirection: 'row' }, desktopSidebar: { width: 270, padding: 16, gap: 12, backgroundColor: c.paleMist, borderRightWidth: 1, borderRightColor: c.border }, desktopMain: { flex: 1, minWidth: 0 }, sidebarBrand: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10 }, sidebarSearch: { height: 42, paddingHorizontal: 11, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.white, color: c.primaryText, fontSize: 12 }, sidebarList: { flex: 1, minHeight: 100 }, sidebarItem: { padding: 10, borderRadius: 10, gap: 4 }, sidebarItemActive: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }, sidebarItemTitle: { color: c.primaryText, fontSize: 12, fontWeight: '700' }, sidebarItemSummary: { color: c.secondaryText, fontSize: 10 }, sidebarNav: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 10, borderTopWidth: 1, borderTopColor: c.border }, sidebarNavText: { color: c.deepBlue, fontSize: 12, fontWeight: '700' }, historyActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chatImage: { width: '100%', height: 230, borderRadius: 12, backgroundColor: c.surface }, imageRemoved: { color: c.secondaryText, fontSize: 11, fontStyle: 'italic' },
  mediaActions: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 5 }, mediaAction: { minHeight: 34, justifyContent: 'center', paddingHorizontal: 11, borderRadius: 12, backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border }, mediaActionActive: { backgroundColor: c.deepBlue, borderColor: c.deepBlue }, mediaActionText: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 0.4 }, mediaActionActiveText: { color: c.white }, imageModeHint: { flex: 1, color: c.secondaryText, fontSize: 9, textAlign: 'right' }, selectedImageRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 7, padding: 6, borderRadius: 13, backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border }, selectedImage: { width: 52, height: 52, borderRadius: 9, backgroundColor: c.surface }, selectedImageTitle: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 }, selectedImageHint: { color: c.secondaryText, fontSize: 9, marginTop: 3 }, removeImage: { minWidth: 38, minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  header: { minHeight: 70, paddingHorizontal: s.lg, paddingTop: s.sm, paddingBottom: s.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.background },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, logo: { width: 42, height: 42, borderRadius: 13, backgroundColor: c.deepBlue, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.accent }, logoText: { color: c.paleMist, fontSize: 26, fontWeight: '800', letterSpacing: -2 }, brand: { color: c.primaryText, fontSize: 20, fontWeight: '800', letterSpacing: 1.5 }, subtitle: { color: c.secondaryText, fontSize: 8, letterSpacing: 0.9, marginTop: 3 }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  action: { minHeight: 44, paddingHorizontal: 13, borderRadius: 14, backgroundColor: c.deepBlue, alignItems: 'center', justifyContent: 'center' }, actionQuiet: { backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border }, actionText: { color: c.white, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 }, actionQuietText: { color: c.deepBlue }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.78 },
  content: { flex: 1, backgroundColor: 'transparent' }, chatContent: { padding: s.lg, paddingBottom: 20, gap: 12, flexGrow: 1 }, welcomeCard: { flex: 1, minHeight: 360, alignItems: 'center', justifyContent: 'center', paddingVertical: 26, gap: 12 }, welcomeMark: { width: 62, height: 62, borderRadius: 21, backgroundColor: c.deepBlue, alignItems: 'center', justifyContent: 'center', shadowColor: c.deepBlue, shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4 }, welcomeMarkText: { fontSize: 35, fontWeight: '800', color: c.paleMist }, welcomeTitle: { color: c.primaryText, fontSize: 24, fontWeight: '700', textAlign: 'center', letterSpacing: -0.4 }, welcomeCopy: { maxWidth: 310, color: c.secondaryText, fontSize: 13, lineHeight: 19, textAlign: 'center' }, promptGrid: { width: '100%', maxWidth: 500, flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 12 }, promptCard: { width: '48%', minHeight: 72, flexGrow: 1, padding: 12, backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border, borderRadius: 15, justifyContent: 'space-between' }, promptText: { color: c.primaryText, fontSize: 12, lineHeight: 17, fontWeight: '600' }, promptArrow: { color: c.accent, fontSize: 14, alignSelf: 'flex-end' },
  message: { width: '100%', maxWidth: 620, borderRadius: 18, padding: 14, borderWidth: 1, gap: 8 }, userMessage: { alignSelf: 'flex-end', backgroundColor: c.deepBlue, borderColor: c.deepBlue, maxWidth: '92%' }, assistantMessage: { alignSelf: 'flex-start', backgroundColor: c.paleMist, borderColor: c.border, maxWidth: '96%' }, messageHeader: { flexDirection: 'row', alignItems: 'center', gap: 7 }, speakerMark: { width: 22, height: 22, borderRadius: 8, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }, speakerMarkText: { fontSize: 11, fontWeight: '800', color: c.deepBlue }, messageRole: { color: c.deepBlue, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 }, userMessageRole: { color: c.paleMist }, messageTime: { marginLeft: 'auto', color: c.secondaryText, fontSize: 10 }, userMessageTime: { color: c.paleMist }, messageText: { color: c.white, fontSize: 14, lineHeight: 21 }, sourcesBlock: { gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }, sourcesTitle: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 }, sourceLink: { minHeight: 40, justifyContent: 'center' }, sourceText: { color: c.deepBlue, fontSize: 11, fontWeight: '700' }, sourceUrl: { color: c.secondaryText, fontSize: 9, marginTop: 2 }, messageTools: { flexDirection: 'row', gap: 7, marginTop: 4 }, toolButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 10, backgroundColor: c.surface, borderRadius: 10 }, toolText: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 }, deliveryRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, failedText: { color: c.error, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 }, retryButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 10, borderWidth: 1, borderColor: c.error, borderRadius: 10 }, retryText: { color: c.error, fontWeight: '800', fontSize: 10 }, typing: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, backgroundColor: c.paleMist, borderRadius: 14, alignSelf: 'flex-start' }, typingText: { color: c.secondaryText, fontSize: 12 },
  banner: { marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 9, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F7E8E9', borderRadius: 12, borderWidth: 1, borderColor: '#E8C4C8' }, successBanner: { backgroundColor: '#E5F3ED', borderColor: '#C4E1D5' }, bannerText: { flex: 1, color: c.primaryText, fontSize: 11, lineHeight: 16 }, bannerClose: { color: c.secondaryText, fontSize: 20, paddingHorizontal: 4 }, composerWrap: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: Platform.OS === 'android' ? 48 : 7, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background }, composer: { minHeight: 54, flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 5, backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border, borderRadius: 20 }, input: { flex: 1, minHeight: 42, maxHeight: 112, color: c.primaryText, paddingHorizontal: 7, paddingTop: 11, paddingBottom: 8, fontSize: 14, lineHeight: 20 }, voiceButton: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface }, voiceActive: { backgroundColor: '#F7E8E9' }, voiceText: { color: c.deepBlue, fontSize: 10, fontWeight: '800' }, voiceTextActive: { color: c.error }, sendButton: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: c.deepBlue }, sendText: { color: c.white, fontSize: 25, lineHeight: 28, fontWeight: '600' }, stopButton: { height: 42, paddingHorizontal: 12, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7E8E9' }, stopText: { color: c.error, fontSize: 10, fontWeight: '800' }, composerHint: { color: c.secondaryText, textAlign: 'center', fontSize: 8, letterSpacing: 0.45, paddingTop: 7 },
  navigationMenu: { alignSelf: 'stretch', marginTop: 'auto', padding: 18, gap: 8, backgroundColor: c.paleMist, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: c.border }, navigationItem: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.border }, navigationItemText: { color: c.primaryText, fontSize: 14, fontWeight: '700' },
  pageContent: { padding: s.lg, gap: 13, paddingBottom: 28 }, pageHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, pageEyebrow: { color: c.deepBlue, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, pageTitle: { color: c.primaryText, fontSize: 27, fontWeight: '700', letterSpacing: -0.5, marginTop: 3 }, pageDescription: { color: c.secondaryText, fontSize: 13, lineHeight: 19, marginBottom: 4 }, emptyCard: { backgroundColor: c.paleMist, padding: 18, borderRadius: 16, borderWidth: 1, borderColor: c.border }, emptyCopy: { color: c.secondaryText, fontSize: 13, lineHeight: 19 }, conversationCard: { minHeight: 84, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.paleMist, borderRadius: 16, borderWidth: 1, borderColor: c.border }, currentConversation: { borderColor: c.accent }, conversationIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }, conversationIconText: { color: c.deepBlue, fontWeight: '800', fontSize: 18 }, conversationInfo: { flex: 1, gap: 3 }, conversationTitle: { color: c.primaryText, fontSize: 13, fontWeight: '700' }, conversationSummary: { color: c.secondaryText, fontSize: 11 }, conversationMeta: { color: c.secondaryText, fontSize: 9 }, deleteConversation: { minWidth: 35, minHeight: 40, alignItems: 'center', justifyContent: 'center' }, deleteConversationText: { color: c.error, fontSize: 24 }, noteCard: { backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 15, gap: 12 }, noteText: { color: c.primaryText, fontSize: 14, lineHeight: 21 }, noteFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, noteDate: { color: c.secondaryText, fontSize: 10 }, noteDelete: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 8 }, noteDeleteText: { color: c.error, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  settingCard: { minHeight: 74, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: c.border, borderRadius: 16, backgroundColor: c.paleMist }, providerChoice: { minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: c.border }, providerChoiceSelected: { backgroundColor: c.surface, borderRadius: 10, borderBottomColor: c.accent, borderWidth: 1 }, providerCheck: { color: c.deepBlue, fontSize: 19, fontWeight: '800', width: 26, textAlign: 'center' }, settingTitle: { color: c.primaryText, fontSize: 13, fontWeight: '700' }, settingDescription: { color: c.secondaryText, fontSize: 11, lineHeight: 16, marginTop: 3 }, settingUrl: { color: c.deepBlue, fontSize: 10, marginTop: 5 }, settingChevron: { color: c.deepBlue, fontSize: 26 }, switchTrack: { width: 48, height: 28, borderRadius: 16, padding: 3, justifyContent: 'center', backgroundColor: c.border }, switchTrackOn: { backgroundColor: c.deepBlue }, switchThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: c.white }, switchThumbOn: { alignSelf: 'flex-end' }, sectionCard: { padding: 14, borderWidth: 1, borderColor: c.border, borderRadius: 16, backgroundColor: c.paleMist }, cardEyebrow: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 4 }, dataRow: { minHeight: 40, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: c.border }, dataLabel: { color: c.secondaryText, fontSize: 11 }, dataValue: { color: c.primaryText, fontSize: 12, fontWeight: '700' }, dataFootnote: { color: c.secondaryText, fontSize: 10, lineHeight: 15, marginTop: 10 }, aboutCard: { gap: 5, padding: 14, backgroundColor: c.surface, borderRadius: 16 }, aboutTitle: { color: c.primaryText, fontSize: 16, fontWeight: '800' }, aboutBrand: { color: c.deepBlue, fontSize: 13 }, smallHint: { color: c.secondaryText, fontSize: 10, lineHeight: 15, paddingHorizontal: 3 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(36,59,80,0.35)', justifyContent: 'center', padding: 14 }, modalScroll: { flexGrow: 1, justifyContent: 'center' }, settingsModal: { padding: 19, backgroundColor: c.paleMist, borderRadius: 22, borderWidth: 1, borderColor: c.border, gap: 11 }, modalTitle: { color: c.primaryText, fontSize: 23, fontWeight: '750' }, modalDescription: { color: c.secondaryText, fontSize: 12, lineHeight: 18 }, fieldLabel: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 0.8, marginTop: 3 }, fieldInput: { minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.white, color: c.primaryText, fontSize: 13 }, fieldHint: { color: c.secondaryText, fontSize: 10, lineHeight: 15 }, modalActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 3 }, checkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
