import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Linking,
  Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet,
  Text, TextInput, View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';
import * as Clipboard from 'expo-clipboard';
import { checkBackend, DEFAULT_API_URL, sendToBackend } from './src/services/wukApi';
import MarkdownMessage from './src/components/MarkdownMessage';
import MatrixRain from './src/components/MatrixRain';
import { colors as c, spacing as s } from './src/theme';

const STORAGE_KEY = '@wuk72_wuk_ai_chat_v2';
const LEGACY_STORAGE_KEY = '@wuk72_wuk_ai_chat_v1';
const OLDER_STORAGE_KEY = '@wuk72_jarvis_chat_v1';
const PAGE_SIZE = 40;
const TEMP_CACHE_PREFIX = '@wuk72_cache_';
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const welcomeMessage = () => ({
  id: newId(), role: 'assistant', time: new Date().toISOString(),
  text: 'Welcome to WUK AI by Wuk72. Ask a question, save a note, or try a local command. Your conversations and notes stay on this device.',
});
const newConversation = (messages = [welcomeMessage()]) => ({ id: newId(), title: 'New conversation', updatedAt: new Date().toISOString(), messages });

const localCommand = raw => {
  const q = raw.trim().toLowerCase();
  if (/^(hi|hello|hey|good morning|good evening)\b/.test(q)) return { reply: 'Hello. WUK AI is ready. What can I help with?' };
  if (q.includes('your name') || q.includes('who are you')) return { reply: 'I’m WUK AI by Wuk72. I can save notes and answer a few commands locally. For open-ended AI answers, I connect to the private Gemini backend.' };
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
  const [screen, setScreen] = useState('chat');
  const [backendUrl, setBackendUrl] = useState(DEFAULT_API_URL);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_API_URL);
  const [accessToken, setAccessToken] = useState('');
  const [draftToken, setDraftToken] = useState('');
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
  const voiceAvailable = Boolean(speechRecognition);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
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
          if (loaded?.length) setConversations(loaded);
          if (Array.isArray(data.notes)) setNotes(data.notes);
          if (typeof data.backendUrl === 'string' && data.backendUrl.trim()) {
            const storedUrl = data.backendUrl.trim();
            const migratedUrl = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/i.test(storedUrl) ? DEFAULT_API_URL : storedUrl;
            setBackendUrl(migratedUrl); setDraftUrl(migratedUrl);
          }
          if (typeof data.autoSpeak === 'boolean') setAutoSpeak(data.autoSpeak);
          if (typeof data.matrixEnabled === 'boolean') setMatrixEnabled(data.matrixEnabled);
          if (data.themeMode === 'frost' || data.themeMode === 'mist') setThemeMode(data.themeMode);
          if (typeof data.activeId === 'string') setActiveId(data.activeId);
        }
      } catch { setBanner('Some saved data could not be read. You can keep using WUK AI and your original data is untouched.'); }
      finally { setHydrated(true); }
    })();
    return () => { isMounted.current = false; requestRef.current?.abort(); Speech.stop(); speechRecognition?.stop?.(); };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const payload = JSON.stringify({ conversations, activeId: activeConversation?.id, notes, backendUrl, autoSpeak, matrixEnabled, themeMode });
    AsyncStorage.setItem(STORAGE_KEY, payload).then(async () => {
      setStorageBytes(utf8ByteLength(payload));
      const keys = await AsyncStorage.getAllKeys();
      setTempCacheCount(keys.filter(key => key.startsWith(TEMP_CACHE_PREFIX)).length);
    }).catch(() => setBanner('Could not save the latest change to local storage.'));
  }, [conversations, activeId, activeConversation?.id, notes, backendUrl, autoSpeak, matrixEnabled, themeMode, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    checkBackend(backendUrl, '').then(result => {
      if (!cancelled) { setConnection('reachable'); setConnectionMessage(result.message); }
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

  function addAssistant(id, text) {
    updateConversation(id, list => [...list, { id: newId(), role: 'assistant', text, time: new Date().toISOString() }]);
  }

  async function startRequest(id, transcript, userMessageId) {
    setBusy(true);
    setBanner('');
    setConnection('checking');
    setConnectionMessage('Waking up WUK AI…');
    const controller = new AbortController();
    requestRef.current = controller;
    const userIndex = transcript.findIndex(message => message.id === userMessageId);
    const context = transcript.slice(0, userIndex + 1);
    try {
      const reply = await sendToBackend(backendUrl, accessToken, context, controller.signal);
      if (!isMounted.current) return;
      updateDelivery(id, userMessageId, 'sent');
      addAssistant(id, reply);
      setConnection('online');
      setConnectionMessage('WUK AI and Gemini are responding');
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

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy || !activeConversation) return;
    const id = activeConversation.id;
    const time = new Date().toISOString();
    const userMessage = { id: newId(), role: 'user', text, time, delivery: 'pending' };
    const nextMessages = [...messages, userMessage];
    setInput('');
    updateConversation(id, nextMessages);
    const local = localCommand(text);
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
    await startRequest(id, nextMessages, userMessage.id);
  }

  async function retryMessage(message) {
    if (busy || !activeConversation || !message) return;
    const index = messages.findIndex(item => item.id === message.id);
    if (index === -1 || message.role !== 'user') return;
    if (!accessToken.trim()) { setBanner('Add the backend access token in Settings, then retry this message.'); return; }
    const id = activeConversation.id;
    const transcript = messages.slice(0, index + 1).map(item => ({ ...item, delivery: item.id === message.id ? 'pending' : item.delivery }));
    updateConversation(id, list => [...list.slice(0, index), { ...list[index], delivery: 'pending' }, ...list.slice(index + 1)]);
    await startRequest(id, transcript, message.id);
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
    setChecking(true); setConnection('checking'); setConnectionMessage('Checking service and Gemini…'); setBanner('');
    try {
      const result = await checkBackend(draftUrl, draftToken);
      setConnection('reachable');
      setConnectionMessage(result.message);
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
    setConnection('reachable'); setConnectionMessage(draftToken.trim() ? 'Connection saved · run a test to verify Gemini' : 'Backend address saved · add access token to use AI');
    setBanner('');
  }

  function deleteNote(id) { setNotes(previous => previous.filter(note => note.id !== id)); }
  function clearTemporaryCache() {
    Alert.alert('Clear temporary cache?', 'Notes and conversations will stay on this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear cache', style: 'destructive', onPress: async () => {
        try {
          const keys = await AsyncStorage.getAllKeys();
          const cacheKeys = keys.filter(key => key.startsWith(TEMP_CACHE_PREFIX));
          if (cacheKeys.length) await AsyncStorage.multiRemove(cacheKeys);
          setTempCacheCount(0); Alert.alert('Cache cleared', 'Your notes and conversations were not changed.');
        } catch { Alert.alert('Could not clear cache', 'Your notes and conversations were not changed.'); }
      } },
    ]);
  }

  const pageBackground = themeMode === 'mist' ? c.paleMist : c.background;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: pageBackground }]}>
      <StatusBar barStyle="dark-content" backgroundColor={pageBackground} />
      <MatrixRain enabled={matrixEnabled} />
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
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
              <View style={styles.messageHeader}><View style={styles.speakerMark}><Text style={styles.speakerMarkText}>{message.role === 'user' ? 'Y' : 'W'}</Text></View><Text style={[styles.messageRole, message.role === 'user' && styles.userMessageRole]}>{message.role === 'user' ? 'YOU' : 'WUK AI'}</Text><Text style={[styles.messageTime, message.role === 'user' && styles.userMessageTime]}>{formatTime(message.time)}</Text></View>
              {message.role === 'assistant' ? <MarkdownMessage text={message.text} /> : <Text selectable style={styles.messageText}>{message.text}</Text>}
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
            <View style={styles.composer}>
              <Pressable accessibilityRole="button" accessibilityLabel={voiceListening ? 'Stop voice input' : 'Start voice input'} onPress={toggleListening} style={[styles.voiceButton, voiceListening && styles.voiceActive]}><Text style={[styles.voiceText, voiceListening && styles.voiceTextActive]}>{voiceListening ? '■' : 'MIC'}</Text></Pressable>
              <TextInput value={input} onChangeText={setInput} onSubmitEditing={sendMessage} placeholder={voiceListening ? 'Listening… edit transcript before sending' : 'Message WUK AI…'} placeholderTextColor={c.secondaryText} style={styles.input} returnKeyType="send" multiline maxLength={2000} editable={!busy} accessibilityLabel="Message WUK AI" />
              {busy ? <Pressable accessibilityRole="button" accessibilityLabel="Stop waiting for response" onPress={() => requestRef.current?.abort()} style={styles.stopButton}><Text style={styles.stopText}>CANCEL</Text></Pressable> : <Pressable accessibilityRole="button" accessibilityLabel="Send message" onPress={sendMessage} disabled={!input.trim()} style={[styles.sendButton, !input.trim() && styles.disabled]}><Text style={styles.sendText}>↑</Text></Pressable>}
            </View>
            <Text style={styles.composerHint}>{voiceAvailable ? 'VOICE INPUT READY' : 'VOICE INPUT NEEDS A DEVELOPMENT BUILD'}  ·  LOCAL NOTES STAY ON THIS PHONE</Text>
          </View>
        </> : screen === 'history' ? <ScrollView style={styles.content} contentContainerStyle={styles.pageContent}>
          <View style={styles.pageHeadingRow}><View><Text style={styles.pageEyebrow}>YOUR LIBRARY</Text><Text style={styles.pageTitle}>Conversations</Text></View><Action label="＋ NEW" onPress={newChat} /></View>
          {!conversations.length ? <Text style={styles.emptyCopy}>Your saved conversations will appear here.</Text> : [...conversations].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(item => <Pressable key={item.id} onPress={() => { setActiveId(item.id); setScreen('chat'); setVisibleCount(PAGE_SIZE); setBanner(''); }} style={({ pressed }) => [styles.conversationCard, item.id === activeId && styles.currentConversation, pressed && styles.pressed]}>
            <View style={styles.conversationIcon}><Text style={styles.conversationIconText}>W</Text></View><View style={styles.conversationInfo}><Text numberOfLines={1} style={styles.conversationTitle}>{item.title}</Text><Text numberOfLines={1} style={styles.conversationSummary}>{item.messages.filter(m => m.role === 'user').at(-1)?.text || 'No messages yet'}</Text><Text style={styles.conversationMeta}>{item.messages.length} messages · {new Date(item.updatedAt).toLocaleDateString()}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Delete conversation" onPress={() => deleteConversation(item.id)} hitSlop={12} style={styles.deleteConversation}><Text style={styles.deleteConversationText}>×</Text></Pressable>
          </Pressable>)}
        </ScrollView> : screen === 'notes' ? <ScrollView style={styles.content} contentContainerStyle={styles.pageContent}>
          <Text style={styles.pageEyebrow}>ON-DEVICE MEMORY</Text><Text style={styles.pageTitle}>Your notes</Text><Text style={styles.pageDescription}>Notes stay on this phone and are never automatically sent to Gemini.</Text>
          {notes.length === 0 ? <View style={styles.emptyCard}><Text style={styles.emptyCopy}>No notes saved yet. In Chat, type “note followed by your note”.</Text></View> : notes.map(note => <View key={note.id} style={styles.noteCard}><Text style={styles.noteText}>{note.text}</Text><View style={styles.noteFooter}><Text style={styles.noteDate}>{new Date(note.createdAt).toLocaleString()}</Text><Pressable accessibilityRole="button" onPress={() => deleteNote(note.id)} style={styles.noteDelete}><Text style={styles.noteDeleteText}>DELETE</Text></Pressable></View></View>)}
        </ScrollView> : <ScrollView style={styles.content} contentContainerStyle={styles.pageContent}>
          <Text style={styles.pageEyebrow}>PREFERENCES & DIAGNOSTICS</Text><Text style={styles.pageTitle}>Settings</Text>
          <Pressable onPress={() => { setDraftUrl(backendUrl); setDraftToken(accessToken); setSettingsOpen(true); }} style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>AI connection</Text><Text style={styles.settingDescription}>{connectionMessage}</Text><Text numberOfLines={1} style={styles.settingUrl}>{backendUrl}</Text></View><Text style={styles.settingChevron}>›</Text></Pressable>
          <View style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Theme · {themeMode === 'frost' ? 'WUK Frost' : 'Pale Mist'}</Text><Text style={styles.settingDescription}>Switch between the two WUK blue palette backgrounds.</Text></View><SwitchRow value={themeMode === 'mist'} onValueChange={value => setThemeMode(value ? 'mist' : 'frost')} label="Switch between WUK Frost and Pale Mist themes" /></View>
          <View style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Speak new responses</Text><Text style={styles.settingDescription}>Use the Android text-to-speech engine when replies arrive.</Text></View><SwitchRow value={autoSpeak} onValueChange={setAutoSpeak} label="Toggle spoken responses" /></View>
          <View style={styles.settingCard}><View style={{ flex: 1 }}><Text style={styles.settingTitle}>Matrix Rain</Text><Text style={styles.settingDescription}>A subtle moving background. Off by default to save battery.</Text></View><SwitchRow value={matrixEnabled} onValueChange={setMatrixEnabled} label="Toggle Matrix Rain" /></View>
          <View style={styles.sectionCard}><Text style={styles.cardEyebrow}>LOCAL DATA</Text><DataRow label="Conversations" value={`${conversations.length}`} /><DataRow label="Messages" value={`${totalMessages}`} /><DataRow label="Notes" value={`${notes.length}`} /><DataRow label="Saved data estimate" value={formatBytes(storageBytes)} /><DataRow label="Temporary cache items" value={`${tempCacheCount}`} /><Text style={styles.dataFootnote}>Approximate JSON data size; Android storage overhead is not included. WUK AI does not save audio recordings.</Text></View>
          <Action label="CLEAR TEMPORARY CACHE" quiet onPress={clearTemporaryCache} />
          <Action label="CLEAR ALL CONVERSATIONS" quiet onPress={clearHistory} />
          <View style={styles.aboutCard}><Text style={styles.aboutTitle}>WUK AI <Text style={styles.aboutBrand}>by Wuk72</Text></Text><Text style={styles.settingDescription}>Version 1.0.0 · Expo SDK 57</Text><Text style={styles.settingDescription}>No notes or conversation history are uploaded unless you choose to send a message to the AI backend.</Text></View>
          <Text style={styles.smallHint}>{voiceAvailable ? 'Speech recognition module available.' : 'Speech-to-text requires a WUK AI development build. Expo Go supports the rest of the app.'} Text-to-speech works with Expo Go.</Text>
        </ScrollView>}

      </KeyboardAvoidingView>

      <Modal visible={navigationOpen} transparent animationType="fade" onRequestClose={() => setNavigationOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNavigationOpen(false)}>
          <View style={styles.navigationMenu}>
            <Text style={styles.pageEyebrow}>WUK AI · NAVIGATION</Text>
            {[
              ['chat', 'Chat'], ['history', 'Conversations'], ['notes', 'Notes'], ['settings', 'Settings'],
            ].map(([key, label]) => <Pressable key={key} accessibilityRole="button" onPress={() => { setScreen(key); setNavigationOpen(false); }} style={styles.navigationItem}><Text style={styles.navigationItemText}>{label}</Text><Text style={styles.settingChevron}>›</Text></Pressable>)}
            <View style={styles.modalActions}><Action label="＋ NEW CHAT" onPress={() => { setNavigationOpen(false); newChat(); }} /><Action label="CLOSE" quiet onPress={() => setNavigationOpen(false)} /></View>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}><ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled"><View style={styles.settingsModal}>
          <Text style={styles.pageEyebrow}>WUK72 · PRIVATE CONNECTION</Text><Text style={styles.modalTitle}>Connect Gemini</Text><Text style={styles.modalDescription}>The app calls your Node backend. Your Gemini API key stays in Render; the private access token is kept only in app memory for this session.</Text>
          <Text style={styles.fieldLabel}>BACKEND URL</Text><TextInput value={draftUrl} onChangeText={setDraftUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://wuk-ai.onrender.com" placeholderTextColor={c.secondaryText} style={styles.fieldInput} />
          <Text style={styles.fieldLabel}>BACKEND ACCESS TOKEN</Text><TextInput value={draftToken} onChangeText={setDraftToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Enter token from backend environment" placeholderTextColor={c.secondaryText} style={styles.fieldInput} />
          <Text style={styles.fieldHint}>Health check proves the service is reachable. The authenticated status check verifies whether Gemini is configured. The token is not saved to chat history or local storage.</Text>
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
  header: { minHeight: 70, paddingHorizontal: s.lg, paddingTop: s.sm, paddingBottom: s.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.background },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, logo: { width: 42, height: 42, borderRadius: 13, backgroundColor: c.deepBlue, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.accent }, logoText: { color: c.paleMist, fontSize: 26, fontWeight: '800', letterSpacing: -2 }, brand: { color: c.primaryText, fontSize: 20, fontWeight: '800', letterSpacing: 1.5 }, subtitle: { color: c.secondaryText, fontSize: 8, letterSpacing: 0.9, marginTop: 3 }, headerActions: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  action: { minHeight: 44, paddingHorizontal: 13, borderRadius: 14, backgroundColor: c.deepBlue, alignItems: 'center', justifyContent: 'center' }, actionQuiet: { backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border }, actionText: { color: c.white, fontSize: 11, fontWeight: '800', letterSpacing: 0.4 }, actionQuietText: { color: c.deepBlue }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.78 },
  content: { flex: 1, backgroundColor: 'transparent' }, chatContent: { padding: s.lg, paddingBottom: 20, gap: 12, flexGrow: 1 }, welcomeCard: { flex: 1, minHeight: 360, alignItems: 'center', justifyContent: 'center', paddingVertical: 26, gap: 12 }, welcomeMark: { width: 62, height: 62, borderRadius: 21, backgroundColor: c.deepBlue, alignItems: 'center', justifyContent: 'center', shadowColor: c.deepBlue, shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4 }, welcomeMarkText: { fontSize: 35, fontWeight: '800', color: c.paleMist }, welcomeTitle: { color: c.primaryText, fontSize: 24, fontWeight: '700', textAlign: 'center', letterSpacing: -0.4 }, welcomeCopy: { maxWidth: 310, color: c.secondaryText, fontSize: 13, lineHeight: 19, textAlign: 'center' }, promptGrid: { width: '100%', maxWidth: 500, flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 12 }, promptCard: { width: '48%', minHeight: 72, flexGrow: 1, padding: 12, backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border, borderRadius: 15, justifyContent: 'space-between' }, promptText: { color: c.primaryText, fontSize: 12, lineHeight: 17, fontWeight: '600' }, promptArrow: { color: c.accent, fontSize: 14, alignSelf: 'flex-end' },
  message: { width: '100%', maxWidth: 620, borderRadius: 18, padding: 14, borderWidth: 1, gap: 8 }, userMessage: { alignSelf: 'flex-end', backgroundColor: c.deepBlue, borderColor: c.deepBlue, maxWidth: '92%' }, assistantMessage: { alignSelf: 'flex-start', backgroundColor: c.paleMist, borderColor: c.border, maxWidth: '96%' }, messageHeader: { flexDirection: 'row', alignItems: 'center', gap: 7 }, speakerMark: { width: 22, height: 22, borderRadius: 8, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }, speakerMarkText: { fontSize: 11, fontWeight: '800', color: c.deepBlue }, messageRole: { color: c.deepBlue, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 }, userMessageRole: { color: c.paleMist }, messageTime: { marginLeft: 'auto', color: c.secondaryText, fontSize: 10 }, userMessageTime: { color: c.paleMist }, messageText: { color: c.white, fontSize: 14, lineHeight: 21 }, messageTools: { flexDirection: 'row', gap: 7, marginTop: 4 }, toolButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 10, backgroundColor: c.surface, borderRadius: 10 }, toolText: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 }, deliveryRow: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, failedText: { color: c.error, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 }, retryButton: { minHeight: 38, justifyContent: 'center', paddingHorizontal: 10, borderWidth: 1, borderColor: c.error, borderRadius: 10 }, retryText: { color: c.error, fontWeight: '800', fontSize: 10 }, typing: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, backgroundColor: c.paleMist, borderRadius: 14, alignSelf: 'flex-start' }, typingText: { color: c.secondaryText, fontSize: 12 },
  banner: { marginHorizontal: 12, marginBottom: 6, paddingHorizontal: 12, paddingVertical: 9, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F7E8E9', borderRadius: 12, borderWidth: 1, borderColor: '#E8C4C8' }, successBanner: { backgroundColor: '#E5F3ED', borderColor: '#C4E1D5' }, bannerText: { flex: 1, color: c.primaryText, fontSize: 11, lineHeight: 16 }, bannerClose: { color: c.secondaryText, fontSize: 20, paddingHorizontal: 4 }, composerWrap: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: Platform.OS === 'android' ? 36 : 7, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.background }, composer: { minHeight: 54, flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 5, backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border, borderRadius: 20 }, input: { flex: 1, minHeight: 42, maxHeight: 112, color: c.primaryText, paddingHorizontal: 7, paddingTop: 11, paddingBottom: 8, fontSize: 14, lineHeight: 20 }, voiceButton: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface }, voiceActive: { backgroundColor: '#F7E8E9' }, voiceText: { color: c.deepBlue, fontSize: 10, fontWeight: '800' }, voiceTextActive: { color: c.error }, sendButton: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: c.deepBlue }, sendText: { color: c.white, fontSize: 25, lineHeight: 28, fontWeight: '600' }, stopButton: { height: 42, paddingHorizontal: 12, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F7E8E9' }, stopText: { color: c.error, fontSize: 10, fontWeight: '800' }, composerHint: { color: c.secondaryText, textAlign: 'center', fontSize: 8, letterSpacing: 0.45, paddingTop: 7 },
  navigationMenu: { alignSelf: 'stretch', marginTop: 'auto', padding: 18, gap: 8, backgroundColor: c.paleMist, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderColor: c.border }, navigationItem: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: c.border }, navigationItemText: { color: c.primaryText, fontSize: 14, fontWeight: '700' },
  pageContent: { padding: s.lg, gap: 13, paddingBottom: 28 }, pageHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, pageEyebrow: { color: c.deepBlue, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 }, pageTitle: { color: c.primaryText, fontSize: 27, fontWeight: '700', letterSpacing: -0.5, marginTop: 3 }, pageDescription: { color: c.secondaryText, fontSize: 13, lineHeight: 19, marginBottom: 4 }, emptyCard: { backgroundColor: c.paleMist, padding: 18, borderRadius: 16, borderWidth: 1, borderColor: c.border }, emptyCopy: { color: c.secondaryText, fontSize: 13, lineHeight: 19 }, conversationCard: { minHeight: 84, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.paleMist, borderRadius: 16, borderWidth: 1, borderColor: c.border }, currentConversation: { borderColor: c.accent }, conversationIcon: { width: 38, height: 38, borderRadius: 14, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }, conversationIconText: { color: c.deepBlue, fontWeight: '800', fontSize: 18 }, conversationInfo: { flex: 1, gap: 3 }, conversationTitle: { color: c.primaryText, fontSize: 13, fontWeight: '700' }, conversationSummary: { color: c.secondaryText, fontSize: 11 }, conversationMeta: { color: c.secondaryText, fontSize: 9 }, deleteConversation: { minWidth: 35, minHeight: 40, alignItems: 'center', justifyContent: 'center' }, deleteConversationText: { color: c.error, fontSize: 24 }, noteCard: { backgroundColor: c.paleMist, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 15, gap: 12 }, noteText: { color: c.primaryText, fontSize: 14, lineHeight: 21 }, noteFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, noteDate: { color: c.secondaryText, fontSize: 10 }, noteDelete: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 8 }, noteDeleteText: { color: c.error, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  settingCard: { minHeight: 74, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: c.border, borderRadius: 16, backgroundColor: c.paleMist }, settingTitle: { color: c.primaryText, fontSize: 13, fontWeight: '700' }, settingDescription: { color: c.secondaryText, fontSize: 11, lineHeight: 16, marginTop: 3 }, settingUrl: { color: c.deepBlue, fontSize: 10, marginTop: 5 }, settingChevron: { color: c.deepBlue, fontSize: 26 }, switchTrack: { width: 48, height: 28, borderRadius: 16, padding: 3, justifyContent: 'center', backgroundColor: c.border }, switchTrackOn: { backgroundColor: c.deepBlue }, switchThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: c.white }, switchThumbOn: { alignSelf: 'flex-end' }, sectionCard: { padding: 14, borderWidth: 1, borderColor: c.border, borderRadius: 16, backgroundColor: c.paleMist }, cardEyebrow: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 4 }, dataRow: { minHeight: 40, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: c.border }, dataLabel: { color: c.secondaryText, fontSize: 11 }, dataValue: { color: c.primaryText, fontSize: 12, fontWeight: '700' }, dataFootnote: { color: c.secondaryText, fontSize: 10, lineHeight: 15, marginTop: 10 }, aboutCard: { gap: 5, padding: 14, backgroundColor: c.surface, borderRadius: 16 }, aboutTitle: { color: c.primaryText, fontSize: 16, fontWeight: '800' }, aboutBrand: { color: c.deepBlue, fontSize: 13 }, smallHint: { color: c.secondaryText, fontSize: 10, lineHeight: 15, paddingHorizontal: 3 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(36,59,80,0.35)', justifyContent: 'center', padding: 14 }, modalScroll: { flexGrow: 1, justifyContent: 'center' }, settingsModal: { padding: 19, backgroundColor: c.paleMist, borderRadius: 22, borderWidth: 1, borderColor: c.border, gap: 11 }, modalTitle: { color: c.primaryText, fontSize: 23, fontWeight: '750' }, modalDescription: { color: c.secondaryText, fontSize: 12, lineHeight: 18 }, fieldLabel: { color: c.deepBlue, fontSize: 9, fontWeight: '800', letterSpacing: 0.8, marginTop: 3 }, fieldInput: { minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.white, color: c.primaryText, fontSize: 13 }, fieldHint: { color: c.secondaryText, fontSize: 10, lineHeight: 15 }, modalActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 3 }, checkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
