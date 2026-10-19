import React from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
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

export default function MarkdownMessage({ text }) {
  const blocks = [];
  const lines = String(text || '').split('\n');
  let paragraph = [];
  let code = [];
  let insideCode = false;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'text', value: paragraph.join(' ').trim() });
    paragraph = [];
  };

  lines.forEach(line => {
    if (line.trim().startsWith('```')) {
      if (insideCode) blocks.push({ type: 'code', value: code.join('\n') });
      else flushParagraph();
      insideCode = !insideCode;
      code = [];
      return;
    }
    if (insideCode) { code.push(line); return; }
    if (!line.trim()) { flushParagraph(); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); blocks.push({ type: 'heading', value: heading[2] }); return; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) { flushParagraph(); blocks.push({ type: 'list', value: `•  ${(bullet || ordered)[1]}` }); return; }
    paragraph.push(line.trim());
  });
  if (insideCode) blocks.push({ type: 'code', value: code.join('\n') });
  flushParagraph();

  return <View style={{ gap: 8 }}>{blocks.map((block, index) => block.type === 'code'
    ? <ScrollView key={index} horizontal style={{ maxWidth: '100%', backgroundColor: colors.paleMist, borderRadius: 8 }} contentContainerStyle={{ padding: 10 }}><Text selectable style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 18, color: colors.primaryText }}>{block.value}</Text></ScrollView>
    : <InlineText key={index} text={block.value} style={{ color: colors.primaryText, fontSize: block.type === 'heading' ? 16 : 14, lineHeight: 22, fontWeight: block.type === 'heading' ? '700' : '400' }} />
  )}</View>;
}
