import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SafeAreaView, View, Text, TextInput, Pressable, ScrollView,
  StyleSheet, KeyboardAvoidingView, Platform, StatusBar, Alert, Modal
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';

const STORAGE_KEY = '@wuk72_wuk_ai_chat_v1';
const LEGACY_STORAGE_KEY = '@wuk72_jarvis_chat_v1';
const GREEN = '#7CFF9B';
const BACKGROUND = '#050806';
const DEFAULT_API_URL = 'http://10.0.2.2:8787';
const PAGE_SIZE = 40;
const TEMP_CACHE_PREFIX = '@wuk72_cache_';

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function localCommand(raw) {
  const q = raw.trim().toLowerCase();
  if (!q) return { reply: 'Type a message to begin.' };
  if (/^(hi|hello|hey|good morning|good evening)\b/.test(q)) return { reply: 'Hello. WUK AI local systems are ready. What can I help with?' };
  if (q.includes('your name') || q.includes('who are you')) return { reply: 'I’m WUK AI by Wuk72. I can handle a few useful commands offline, save notes on this phone, and connect to your private AI backend when configured.' };
  if (q.includes('time')) return { reply: `The time on this device is ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` };
  if (q.includes('date') || q.includes('day is it')) return { reply: `Today is ${new Date().toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.` };
  if (q.startsWith('note ') || q.startsWith('remember ')) return { note: raw.replace(/^(note|remember)\s+/i, '').trim() };
  if (q.includes('what can you do') || q === 'help') return { reply: 'I can tell you the time and date, save notes locally, and speak replies aloud without internet. For open-ended questions, configure the private Node backend in Settings. If it is offline, I’ll say so instead of pretending a preset answer is AI.' };
  if (q.includes('offline')) return { reply: 'Offline mode supports time and date commands, local notes, chat history, and speech output. Open-ended AI replies need your private backend connection.' };
  return null;
}

const welcomeMessage = () => ({
  id: 'welcome', role: 'assistant', time: new Date().toISOString(),
  text: 'WUK AI by Wuk72 is ready. Local commands and notes work offline. Connect your private AI backend in Settings for open-ended answers.'
});

export default function App() {
  const [messages, setMessages] = useState([welcomeMessage()]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [notes, setNotes] = useState([]);
  const [tab, setTab] = useState('chat');
  const [speakingId, setSpeakingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [backendUrl, setBackendUrl] = useState(DEFAULT_API_URL);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_API_URL);
  const [accessToken, setAccessToken] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const [connection, setConnection] = useState('local');
  const [connectionMessage, setConnectionMessage] = useState('Offline commands ready');
  const [visibleMessageCount, setVisibleMessageCount] = useState(PAGE_SIZE);
  const [visibleNoteCount, setVisibleNoteCount] = useState(PAGE_SIZE);
  const [storedBytes, setStoredBytes] = useState(0);
  const [temporaryCacheCount, setTemporaryCacheCount] = useState(0);
  const scrollRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        let saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (!saved) saved = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed.messages) && parsed.messages.length) setMessages(parsed.messages);
          if (Array.isArray(parsed.notes)) setNotes(parsed.notes);
          if (typeof parsed.backendUrl === 'string') {
            setBackendUrl(parsed.backendUrl);
            setDraftUrl(parsed.backendUrl);
          }
        }
      } catch { /* app remains usable if local storage is unavailable */ }
      finally { setHydrated(true); }
    })();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const serialized = JSON.stringify({ messages, notes, backendUrl });
    AsyncStorage.setItem(STORAGE_KEY, serialized).then(async () => {
      setStoredBytes(utf8ByteLength(serialized));
      const keys = await AsyncStorage.getAllKeys();
      setTemporaryCacheCount(keys.filter(key => key.startsWith(TEMP_CACHE_PREFIX)).length);
    }).catch(() => {});
  }, [messages, notes, backendUrl, hydrated]);

  const statusLabel = useMemo(() => {
    if (busy) return 'WAITING FOR PRIVATE AI';
    if (connection === 'online') return 'PRIVATE AI CONNECTED';
    if (connection === 'error') return 'BACKEND UNAVAILABLE';
    return 'LOCAL SYSTEMS READY';
  }, [busy, connection]);

  function addMessage(role, text) {
    const message = { id: `${Date.now()}-${Math.random()}`, role, text, time: new Date().toISOString() };
    setMessages(prev => [...prev, message]);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    const userMessage = { id: `${Date.now()}-${Math.random()}`, role: 'user', text, time: new Date().toISOString() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);

    const local = localCommand(text);
    if (local?.note !== undefined) {
      if (local.note) {
        setNotes(prev => [{ id: `${Date.now()}`, text: local.note, createdAt: new Date().toISOString() }, ...prev]);
        addMessage('assistant', `Saved on this phone: “${local.note}”`);
      } else addMessage('assistant', 'Tell me what to save, for example: “note call the dentist”.');
      return;
    }
    if (local?.reply) {
      addMessage('assistant', local.reply);
      return;
    }

    if (!backendUrl.trim() || !accessToken.trim()) {
      setConnection('local');
      setConnectionMessage('Backend not configured. Offline commands are still ready.');
      addMessage('assistant', 'I can’t answer that as AI while the private backend isn’t configured. Open Settings to connect it. Offline commands and saved notes remain available.');
      return;
    }

    setBusy(true);
    setConnection('checking');
    setConnectionMessage('Contacting your private Wuk72 backend…');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const response = await fetch(`${backendUrl.trim().replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.trim()}` },
        body: JSON.stringify({ messages: nextMessages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-16).map(({ role, text: content }) => ({ role, content })) }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('The backend returned an empty response.');
      setConnection('online');
      setConnectionMessage('Connected to your private AI backend');
      addMessage('assistant', data.reply.trim());
    } catch (error) {
      setConnection('error');
      setConnectionMessage(error.name === 'AbortError' ? 'Backend request timed out' : 'Backend unavailable — local commands still work');
      addMessage('assistant', `I couldn’t reach your private AI backend${error.name === 'AbortError' ? ' before the request timed out' : ''}. I haven’t generated an AI answer. Check the backend and network, then try again. Local commands and notes still work.`);
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  }

  function speak(message) {
    Speech.stop();
    setSpeakingId(message.id);
    Speech.speak(message.text, {
      language: 'en-US', rate: 0.94, pitch: 0.92,
      onDone: () => setSpeakingId(null), onStopped: () => setSpeakingId(null), onError: () => setSpeakingId(null)
    });
  }

  function stopSpeaking() {
    Speech.stop();
    setSpeakingId(null);
  }

  function clearChat() {
    Alert.alert('Clear conversation?', 'This clears saved chat history but keeps your notes.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setMessages([welcomeMessage()]) }
    ]);
  }

  function saveSettings() {
    const normalizedUrl = draftUrl.trim().replace(/\/+$/, '');
    if (normalizedUrl && !/^https?:\/\//i.test(normalizedUrl)) {
      Alert.alert('Check the server address', 'Enter a full address beginning with http:// or https://.');
      return;
    }
    setBackendUrl(normalizedUrl);
    setAccessToken(draftToken.trim());
    setConnection('local');
    setConnectionMessage(draftToken.trim() ? 'Ready to connect on your next message' : 'Offline commands ready');
    setSettingsOpen(false);
  }

  function deleteNote(id) { setNotes(prev => prev.filter(n => n.id !== id)); }

  function clearTemporaryCache() {
    Alert.alert('Clear temporary cache?', 'This only removes temporary WUK AI cache entries. Your notes and chat history will stay on this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear cache', style: 'destructive', onPress: async () => {
        try {
          const keys = await AsyncStorage.getAllKeys();
          const cacheKeys = keys.filter(key => key.startsWith(TEMP_CACHE_PREFIX));
          if (cacheKeys.length) await AsyncStorage.multiRemove(cacheKeys);
          setTemporaryCacheCount(0);
          Alert.alert('Cache cleared', cacheKeys.length ? 'Temporary cache entries were removed.' : 'There was no temporary cache to remove.');
        } catch {
          Alert.alert('Could not clear cache', 'Your notes and chat history were not changed.');
        }
      } }
    ]);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={BACKGROUND} />
      <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.logo}><Text style={styles.logoText}>W</Text></View>
            <View>
              <Text style={styles.brand}>WUK <Text style={styles.brandAccent}>AI</Text></Text>
              <Text style={styles.subtitle}>BY WUK72  /  PERSONAL INTELLIGENCE</Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Open backend settings" onPress={() => { setDraftUrl(backendUrl); setDraftToken(accessToken); setSettingsOpen(true); }} style={styles.iconButton}><Text style={styles.iconButtonText}>LINK</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Clear conversation" onPress={clearChat} style={styles.iconButton}><Text style={styles.iconButtonText}>CLEAR</Text></Pressable>
          </View>
        </View>

        <View style={styles.statusBar}>
          <View style={[styles.statusDot, connection === 'error' && styles.statusDotError, busy && styles.statusDotBusy]} />
          <Text numberOfLines={1} style={styles.statusText}>{statusLabel}</Text>
          <Text style={styles.modeText}>{connection === 'online' ? 'ONLINE' : 'OFFLINE'}</Text>
        </View>

        <View style={styles.hero}>
          <View style={styles.heroGrid} />
          <View style={styles.orbitOuter}><View style={styles.orbitInner}><View style={styles.core}><Text style={styles.coreText}>W</Text></View></View></View>
          <Text style={styles.heroTitle}>THINK CLEAR. MOVE FORWARD.</Text>
          <Text style={styles.heroCaption}>LOCAL COMMANDS  ·  PRIVATE AI  ·  ON-DEVICE MEMORY</Text>
        </View>

        <View style={styles.tabs}>
          <Pressable accessibilityRole="tab" onPress={() => setTab('chat')} style={[styles.tab, tab === 'chat' && styles.activeTab]}><Text style={[styles.tabText, tab === 'chat' && styles.activeTabText]}>CHAT</Text></Pressable>
          <Pressable accessibilityRole="tab" onPress={() => setTab('notes')} style={[styles.tab, tab === 'notes' && styles.activeTab]}><Text style={[styles.tabText, tab === 'notes' && styles.activeTabText]}>NOTES  /  {notes.length}</Text></Pressable>
          <Pressable accessibilityRole="tab" onPress={() => setTab('storage')} style={[styles.tab, tab === 'storage' && styles.activeTab]}><Text style={[styles.tabText, tab === 'storage' && styles.activeTabText]}>DEVICE</Text></Pressable>
        </View>

        {tab === 'chat' ? (
          <>
            <ScrollView ref={scrollRef} style={styles.chat} contentContainerStyle={styles.chatContent} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
              {messages.length > visibleMessageCount && <Pressable accessibilityRole="button" onPress={() => setVisibleMessageCount(count => count + PAGE_SIZE)} style={styles.loadOlder}><Text style={styles.loadOlderText}>LOAD {Math.min(PAGE_SIZE, messages.length - visibleMessageCount)} OLDER MESSAGES</Text></Pressable>}
              {messages.slice(-visibleMessageCount).map(m => (
                <View key={m.id} style={[styles.message, m.role === 'user' ? styles.userMessage : styles.assistantMessage]}>
                  <View style={styles.messageHeader}><Text style={styles.messageRole}>{m.role === 'user' ? 'YOU' : 'WUK AI'}</Text><Text style={styles.messageTime}>{new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text></View>
                  <Text style={styles.messageText}>{m.text}</Text>
                  {m.role === 'assistant' && <Pressable accessibilityRole="button" accessibilityLabel={speakingId === m.id ? 'Stop speaking' : 'Speak response'} onPress={() => speakingId === m.id ? stopSpeaking() : speak(m)} style={styles.speakButton}><Text style={styles.speakText}>{speakingId === m.id ? '■  STOP VOICE' : '▶  SPEAK'}</Text></Pressable>}
                </View>
              ))}
              {busy && <View style={styles.typing}><View style={styles.statusDotBusy} /><Text style={styles.typingText}>WUK AI IS THINKING</Text></View>}
            </ScrollView>
            <View style={styles.composer}>
              <TextInput value={input} onChangeText={setInput} onSubmitEditing={sendMessage} placeholder="Ask WUK AI or enter a command…" placeholderTextColor="#77877D" style={styles.input} returnKeyType="send" multiline maxLength={2000} editable={!busy} accessibilityLabel="Message WUK AI" />
              <Pressable accessibilityRole="button" accessibilityLabel="Send message" onPress={sendMessage} disabled={busy || !input.trim()} style={[styles.sendButton, (busy || !input.trim()) && styles.sendButtonDisabled]}><Text style={styles.sendText}>{busy ? '…' : 'SEND  ↗'}</Text></Pressable>
            </View>
            <Text style={styles.hint}>TRY  “what time is it”   ·   “note buy milk”   ·   “help”</Text>
          </>
        ) : tab === 'notes' ? (
          <ScrollView style={styles.chat} contentContainerStyle={styles.notesContent}>
            <Text style={styles.sectionTitle}>YOUR LOCAL MEMORY</Text>
            <Text style={styles.sectionCaption}>Notes stay on this phone and are not sent to the AI backend.</Text>
            {notes.length === 0 ? <Text style={styles.emptyText}>No notes saved yet. In Chat, type “note followed by your note”.</Text> : notes.slice(0, visibleNoteCount).map(n => (
              <View key={n.id} style={styles.noteCard}>
                <Text style={styles.noteText}>{n.text}</Text>
                <View style={styles.noteFooter}><Text style={styles.noteDate}>{new Date(n.createdAt).toLocaleString()}</Text><Pressable accessibilityRole="button" accessibilityLabel="Delete note" hitSlop={8} onPress={() => deleteNote(n.id)}><Text style={styles.deleteText}>DELETE</Text></Pressable></View>
              </View>
            ))}
            {notes.length > visibleNoteCount && <Pressable accessibilityRole="button" onPress={() => setVisibleNoteCount(count => count + PAGE_SIZE)} style={styles.loadOlder}><Text style={styles.loadOlderText}>LOAD OLDER NOTES</Text></Pressable>}
          </ScrollView>
        ) : (
          <ScrollView style={styles.chat} contentContainerStyle={styles.notesContent}>
            <Text style={styles.sectionTitle}>ON-DEVICE STORAGE</Text>
            <Text style={styles.sectionCaption}>WUK AI keeps your notes and chat history on this phone. They are not automatically uploaded to Gemini.</Text>
            <View style={styles.storageCard}>
              <View style={styles.storageRow}><Text style={styles.storageLabel}>CHAT MESSAGES</Text><Text style={styles.storageValue}>{messages.length}</Text></View>
              <View style={styles.storageRow}><Text style={styles.storageLabel}>LOCAL NOTES</Text><Text style={styles.storageValue}>{notes.length}</Text></View>
              <View style={styles.storageRow}><Text style={styles.storageLabel}>SAVED APP DATA</Text><Text style={styles.storageValue}>~{storedBytes < 1024 ? `${storedBytes} B` : `${(storedBytes / 1024).toFixed(1)} KB`}</Text></View>
              <View style={styles.storageRow}><Text style={styles.storageLabel}>TEMP CACHE ENTRIES</Text><Text style={styles.storageValue}>{temporaryCacheCount}</Text></View>
            </View>
            <Text style={styles.sectionCaption}>Size is the serialized WUK AI data payload estimate; Android database overhead is not included. History and notes are retained until you clear them yourself.</Text>
            <Text style={styles.sectionTitle}>TEMPORARY CACHE</Text>
            <Text style={styles.sectionCaption}>This version does not cache AI replies or save audio recordings. Clear cache removes only future temporary entries prefixed for WUK AI; it never removes notes or conversations.</Text>
            <Pressable accessibilityRole="button" onPress={clearTemporaryCache} style={styles.cacheButton}><Text style={styles.cacheButtonText}>CLEAR TEMPORARY CACHE</Text></Pressable>
            <Text style={styles.storageFootnote}>Older chats and notes are loaded in groups of {PAGE_SIZE} to keep the screen responsive. Use CLEAR in Chat when you choose to remove conversation history.</Text>
          </ScrollView>
        )}
        <View style={styles.footer}><Text style={styles.footerText}>WUK72  ·  PRIVATE BY DESIGN</Text><Text style={styles.footerText}>{connectionMessage.toUpperCase()}</Text></View>
      </KeyboardAvoidingView>

      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.settingsCard}>
            <Text style={styles.settingsEyebrow}>WUK72  /  CONNECTION</Text>
            <Text style={styles.settingsTitle}>Private AI backend</Text>
            <Text style={styles.settingsCopy}>Enter the address of your Node backend and its access token. Your Gemini API key stays on the backend. The access token stays in app memory for this session.</Text>
            <Text style={styles.fieldLabel}>SERVER ADDRESS</Text>
            <TextInput value={draftUrl} onChangeText={setDraftUrl} autoCapitalize="none" keyboardType="url" placeholder="http://192.168.1.10:8787" placeholderTextColor="#77877D" style={styles.settingsInput} />
            <Text style={styles.fieldLabel}>BACKEND ACCESS TOKEN</Text>
            <TextInput value={draftToken} onChangeText={setDraftToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Paste the backend token" placeholderTextColor="#77877D" style={styles.settingsInput} />
            <Text style={styles.settingsHint}>On a physical phone, use your computer’s private Wi-Fi address. Keep the backend on a trusted network.</Text>
            <View style={styles.settingsActions}>
              <Pressable accessibilityRole="button" onPress={() => setSettingsOpen(false)} style={styles.cancelButton}><Text style={styles.cancelText}>CANCEL</Text></Pressable>
              <Pressable accessibilityRole="button" onPress={saveSettings} style={styles.saveButton}><Text style={styles.saveText}>SAVE CONNECTION</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BACKGROUND }, container: { flex: 1, backgroundColor: BACKGROUND },
  header: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#1C2A20' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, logo: { width: 42, height: 42, borderRadius: 10, borderWidth: 1, borderColor: '#4D9A62', alignItems: 'center', justifyContent: 'center', backgroundColor: '#101B13' }, logoText: { color: GREEN, fontSize: 26, fontWeight: '700', letterSpacing: -2 }, brand: { color: '#F0F5EF', fontSize: 21, fontWeight: '800', letterSpacing: 2 }, brandAccent: { color: GREEN }, subtitle: { color: '#A0B0A2', fontSize: 9, letterSpacing: 0.8, marginTop: 3 }, headerActions: { flexDirection: 'row', gap: 6 }, iconButton: { minHeight: 44, minWidth: 44, borderWidth: 1, borderColor: '#334339', paddingHorizontal: 9, borderRadius: 7, alignItems: 'center', justifyContent: 'center' }, iconButtonText: { color: '#B8C8BA', fontSize: 9, letterSpacing: 1, fontWeight: '700' },
  statusBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 10, gap: 8, backgroundColor: '#0B100C' }, statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: GREEN }, statusDotError: { backgroundColor: '#FF7777' }, statusDotBusy: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#D7FF86' }, statusText: { color: '#B1C0B2', fontSize: 10, letterSpacing: 0.8, flex: 1 }, modeText: { color: GREEN, fontSize: 10, letterSpacing: 0.8 },
  hero: { alignItems: 'center', paddingTop: 15, paddingBottom: 15, borderBottomWidth: 1, borderBottomColor: '#17221A', overflow: 'hidden' }, heroGrid: { position: 'absolute', top: 0, left: '15%', right: '15%', height: 135, borderBottomWidth: 1, borderColor: '#122016', transform: [{ skewY: '-12deg' }] }, orbitOuter: { width: 100, height: 100, borderRadius: 50, borderWidth: 1, borderColor: '#356B42', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A100B' }, orbitInner: { width: 78, height: 78, borderRadius: 39, borderWidth: 1, borderColor: '#284C32', alignItems: 'center', justifyContent: 'center' }, core: { width: 56, height: 56, borderRadius: 16, borderWidth: 1.5, borderColor: GREEN, alignItems: 'center', justifyContent: 'center', backgroundColor: '#112017' }, coreText: { color: GREEN, fontSize: 31, fontWeight: '700', letterSpacing: -3 }, heroTitle: { color: '#EDF4EC', fontSize: 11, letterSpacing: 2.1, fontWeight: '700', marginTop: 11 }, heroCaption: { color: '#A8B8AA', fontSize: 9, letterSpacing: 0.45, marginTop: 5, textAlign: 'center' },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#202C22' }, tab: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' }, activeTab: { borderBottomColor: GREEN }, tabText: { color: '#A2B0A3', fontSize: 10, letterSpacing: 1.4, fontWeight: '700' }, activeTabText: { color: GREEN }, chat: { flex: 1 }, chatContent: { padding: 13, gap: 11, paddingBottom: 18 }, message: { borderRadius: 11, padding: 12, maxWidth: '94%', borderWidth: 1 }, userMessage: { alignSelf: 'flex-end', backgroundColor: '#102017', borderColor: '#31583B' }, assistantMessage: { alignSelf: 'flex-start', backgroundColor: '#0B100C', borderColor: '#263329' }, messageHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 20 }, messageRole: { color: GREEN, fontSize: 10, letterSpacing: 1.3, fontWeight: '800' }, messageTime: { color: '#A0ADA2', fontSize: 10 }, messageText: { color: '#E0E9E1', fontSize: 14, lineHeight: 21 }, speakButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', marginTop: 8, paddingVertical: 5, paddingHorizontal: 9, borderRadius: 6, borderWidth: 1, borderColor: '#34483A' }, speakText: { color: '#B7D6BC', fontSize: 10, letterSpacing: 0.7 }, typing: { flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10 }, typingText: { color: '#B7C5B9', fontSize: 10, letterSpacing: 0.8 }, loadOlder: { minHeight: 44, borderWidth: 1, borderColor: '#334339', borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, loadOlderText: { color: '#B7D6BC', fontSize: 10, letterSpacing: 0.8, fontWeight: '700' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 11, paddingTop: 9, paddingBottom: 5, borderTopWidth: 1, borderTopColor: '#1C2A20' }, input: { flex: 1, minHeight: 46, maxHeight: 104, color: '#EDF5EE', backgroundColor: '#0B100C', borderWidth: 1, borderColor: '#334339', borderRadius: 9, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14 }, sendButton: { minHeight: 46, paddingHorizontal: 14, borderRadius: 9, backgroundColor: '#14251A', borderWidth: 1, borderColor: GREEN, alignItems: 'center', justifyContent: 'center' }, sendButtonDisabled: { opacity: 0.48 }, sendText: { color: GREEN, fontWeight: '800', fontSize: 10, letterSpacing: 0.8 }, hint: { color: '#A6B3A7', fontSize: 10, paddingHorizontal: 14, paddingBottom: 8, paddingTop: 4 }, footer: { minHeight: 32, paddingVertical: 8, paddingHorizontal: 13, borderTopWidth: 1, borderTopColor: '#17221A', flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, footerText: { color: '#A3AFA5', fontSize: 8, letterSpacing: 0.4, flexShrink: 1 },
  notesContent: { padding: 16, gap: 12 }, sectionTitle: { color: GREEN, fontSize: 12, letterSpacing: 2, fontWeight: '800' }, sectionCaption: { color: '#AAB9AC', fontSize: 12, lineHeight: 18 }, emptyText: { color: '#C0CCC1', fontSize: 13, lineHeight: 20, marginTop: 15 }, noteCard: { backgroundColor: '#0B100C', borderWidth: 1, borderColor: '#29382D', borderRadius: 10, padding: 13, gap: 12 }, noteText: { color: '#E6EEE6', fontSize: 14, lineHeight: 20 }, noteFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, noteDate: { color: '#B0BDB2', fontSize: 10 }, deleteText: { color: '#FFA0A0', fontSize: 10, letterSpacing: 1, fontWeight: '700', padding: 4 }, storageCard: { borderWidth: 1, borderColor: '#29382D', borderRadius: 10, paddingHorizontal: 13, backgroundColor: '#0B100C' }, storageRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: '#1D2920' }, storageLabel: { color: '#B7C5B9', fontSize: 10, letterSpacing: 0.8, fontWeight: '700' }, storageValue: { color: GREEN, fontSize: 13, fontWeight: '700' }, cacheButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#405945', borderRadius: 8, paddingHorizontal: 12 }, cacheButtonText: { color: '#C8D8CA', fontSize: 10, letterSpacing: 0.8, fontWeight: '700' }, storageFootnote: { color: '#A8B5AA', fontSize: 11, lineHeight: 17, marginTop: 3 },
  modalBackdrop: { flex: 1, justifyContent: 'center', padding: 18, backgroundColor: 'rgba(0,0,0,0.78)' }, settingsCard: { backgroundColor: '#0B100C', borderWidth: 1, borderColor: '#405945', borderRadius: 14, padding: 18, gap: 11 }, settingsEyebrow: { color: GREEN, fontSize: 10, letterSpacing: 1.2, fontWeight: '700' }, settingsTitle: { color: '#F0F5EF', fontSize: 20, fontWeight: '700' }, settingsCopy: { color: '#B4C1B6', fontSize: 12, lineHeight: 18, marginBottom: 3 }, fieldLabel: { color: '#B7C8B9', fontSize: 10, letterSpacing: 0.8, fontWeight: '700', marginTop: 3 }, settingsInput: { minHeight: 46, color: '#F0F5EF', backgroundColor: '#070A08', borderWidth: 1, borderColor: '#354339', borderRadius: 8, paddingHorizontal: 11, fontSize: 13 }, settingsHint: { color: '#A8B5AA', fontSize: 10, lineHeight: 15 }, settingsActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 }, cancelButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }, cancelText: { color: '#B7C4B9', fontSize: 10, letterSpacing: 1 }, saveButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 13, borderRadius: 8, backgroundColor: '#14251A', borderWidth: 1, borderColor: GREEN }, saveText: { color: GREEN, fontSize: 9, letterSpacing: 0.7, fontWeight: '800' }
});
