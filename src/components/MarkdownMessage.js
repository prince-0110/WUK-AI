import React from 'react';
import { Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '../theme';

function InlineText({ text, style }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s<>()]+)/g).filter(Boolean);
  return <Text style={style}>{parts.map((part, index) => {
    if (/^https?:\/\//.test(part)) return <Text key={index} accessibilityRole="link" onPress={() => Linking.openURL(part)} style={{ color: colors.deepBlue, textDecorationLine: 'underline' }}>{part}</Text>;
    if (part.startsWith('`') && part.endsWith('`')) return <Text key={index} style={{ fontFamily: 'monospace', backgroundColor: colors.paleMist }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('**') && part.endsWith('**')) return <Text key={index} style={{ fontWeight: '700' }}>{part.slice(2, -2)}</Text>;
    return part;
  })}</Text>;
}

export default function MarkdownMessage({ text, onCopyCode }) {
  const blocks = [];
  const lines = String(text || '').split('\n');
  let paragraph = [];
  let code = [];
  let table = [];
  let insideCode = false;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'text', value: paragraph.join(' ').trim() });
    paragraph = [];
  };
  const flushTable = () => {
    if (table.length) blocks.push({ type: 'table', rows: table });
    table = [];
  };

  lines.forEach(line => {
    if (line.trim().startsWith('```')) {
      if (insideCode) blocks.push({ type: 'code', value: code.join('\n') });
      else { flushParagraph(); flushTable(); }
      insideCode = !insideCode;
      code = [];
      return;
    }
    if (insideCode) { code.push(line); return; }
    const cells = line.trim().startsWith('|') && line.trim().endsWith('|') ? line.trim().slice(1, -1).split('|').map(cell => cell.trim()) : null;
    if (cells && cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell))) return;
    if (cells && cells.length > 1) { flushParagraph(); table.push(cells); return; }
    flushTable();
    if (!line.trim()) { flushParagraph(); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); blocks.push({ type: 'heading', value: heading[2] }); return; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) { flushParagraph(); blocks.push({ type: 'list', value: `•  ${(bullet || ordered)[1]}` }); return; }
    paragraph.push(line.trim());
  });
  if (insideCode) blocks.push({ type: 'code', value: code.join('\n') });
  flushTable();
  flushParagraph();

  return <View style={{ gap: 8 }}>{blocks.map((block, index) => block.type === 'code'
    ? <View key={index} style={{ maxWidth: '100%', backgroundColor: colors.paleMist, borderRadius: 8, overflow: 'hidden' }}><ScrollView horizontal contentContainerStyle={{ padding: 10 }}><Text selectable style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 18, color: colors.primaryText }}>{block.value}</Text></ScrollView><Pressable accessibilityRole="button" accessibilityLabel="Copy code block" onPress={() => onCopyCode?.(block.value)} style={{ minHeight: 38, alignSelf: 'flex-end', justifyContent: 'center', paddingHorizontal: 12 }}><Text style={{ color: colors.deepBlue, fontSize: 10, fontWeight: '800' }}>COPY CODE</Text></Pressable></View>
    : block.type === 'table' ? <ScrollView key={index} horizontal style={{ maxWidth: '100%' }}><View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, overflow: 'hidden' }}>{block.rows.map((row, rowIndex) => <View key={rowIndex} style={{ flexDirection: 'row', backgroundColor: rowIndex === 0 ? colors.surface : colors.paleMist, borderBottomWidth: rowIndex === block.rows.length - 1 ? 0 : 1, borderBottomColor: colors.border }}>{row.map((cell, cellIndex) => <View key={cellIndex} style={{ minWidth: 100, maxWidth: 220, padding: 8, borderRightWidth: cellIndex === row.length - 1 ? 0 : 1, borderRightColor: colors.border }}><InlineText text={cell} style={{ color: colors.primaryText, fontSize: 12, lineHeight: 18, fontWeight: rowIndex === 0 ? '700' : '400' }} /></View>)}</View>)}</View></ScrollView>
    : <InlineText key={index} text={block.value} style={{ color: colors.primaryText, fontSize: block.type === 'heading' ? 16 : 14, lineHeight: 22, fontWeight: block.type === 'heading' ? '700' : '400' }} />
  )}</View>;
}
