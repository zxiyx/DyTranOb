import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSubtitles, readSubtitles, subtitleTracks, subtitleUrl } from '../src/adapters/subtitles.js';

const url = 'https://sf1.douyinstatic.com/subtitle.vtt';
const vtt = 'WEBVTT\n\nNOTE ignored\n\n1\n00:00.640 --> 00:02.120 align:start\n<v speaker>你好 &amp; 世界</v>\n\n2\n00:02.200 --> 00:04.500\n第二句\n';
const detail = (cap: unknown) => ({ aweme_id: '7700982511376561521', video: { cla_info: { caption_infos: cap } } });

test('caption variants merge and deduplicate without rounding native IDs', () => {
  const tracks=subtitleTracks({ video:{cla_info:{caption_info:{url,language_code:'zh-Hans'},caption_infos:[{url},{url_list:['https://sf2.douyinstatic.com/en.vtt'],language:'en'}]},subtitle_infos:[{url:'https://sf3.douyinstatic.com/c.vtt'}]} });
  assert.equal(tracks.length,3); assert.equal(tracks[0]?.language,'zh-Hans');
  assert.equal(tracks[2]?.index,2);
});
test('VTT, SRT and timed JSON normalize seconds and text, HTML/empty text are errors', () => {
  assert.deepEqual(parseSubtitles(vtt),[{start:0.64,end:2.12,text:'你好 & 世界'},{start:2.2,end:4.5,text:'第二句'}]);
  assert.deepEqual(parseSubtitles('1\r\n00:00:01,200 --> 00:00:03,000\r\n字幕'),[{start:1.2,end:3,text:'字幕'}]);
  assert.deepEqual(parseSubtitles(JSON.stringify({utterances:[{start_time:1250,end_time:2000,text:'毫秒'}]})),[{start:1.25,end:2,text:'毫秒'}]);
  assert.deepEqual(parseSubtitles(JSON.stringify({body:[{from:1,to:2,content:'秒'}]})),[{start:1,end:2,text:'秒'}]);
  for (const input of ['<html>login</html>', 'WEBVTT', '{}','1\n00:00:04,000 --> 00:00:03,000\ninvalid']) assert.throws(()=>parseSubtitles(input));
});
test('subtitle selection prefers Chinese, supports exact language/index, and reports no track separately', async () => {
  const d=detail([{url:'https://sf1.douyinstatic.com/en.vtt',language_code:'en'},{url,language_code:'zh-Hans'}]);
  const fetcher:typeof fetch=async(input,init)=>{assert.equal(new Headers(init?.headers).get('cookie'),null);assert.equal(new Headers(init?.headers).get('authorization'),null);return new Response(vtt);};
  const result=await readSubtitles(d,{},fetcher); assert.equal(result.available,true);assert.equal(result.track_index,1);assert.equal(result.text,'你好 & 世界\n第二句');
  assert.equal((await readSubtitles(d,{language:'en'},fetcher)).track_index,0);
  assert.equal((await readSubtitles(d,{track_index:0},fetcher)).track_index,0);
  assert.equal((await readSubtitles(d,{language:'fr'},fetcher)).reason,'language_unavailable');
  assert.equal((await readSubtitles(detail([]),{},fetcher)).reason,'no_subtitle_metadata');
  await assert.rejects(readSubtitles(d,{track_index:31},fetcher),/SUBTITLE_TRACK_NOT_FOUND/);
});
test('subtitle downloads retry backup URLs but reject SSRF redirects, oversize bodies and unsupported text', async () => {
  for(const bad of ['https://127.0.0.1/a','file:///a','https://douyinstatic.com.evil.test/a','https://x:y@sf1.douyinstatic.com/a','https://sf1.douyinstatic.com:8080/a']) assert.throws(()=>subtitleUrl(bad));
  assert.equal(subtitleUrl('http://sf1.douyinstatic.com/a').protocol,'https:');
  let calls=0;
  const fallback:typeof fetch=async()=>{calls++;return calls===1?new Response('',{status:403}):new Response(vtt);};
  assert.equal((await readSubtitles(detail([{url_list:[url,'https://sf2.douyinstatic.com/a']}]),{},fallback)).available,true);assert.equal(calls,2);
  calls=0;
  await assert.rejects(readSubtitles(detail([{url}]),{},async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/internal'}});}),/SUBTITLE_DOWNLOAD_FAILED/); assert.equal(calls,1);
  for(const body of ['<html>challenge</html>','x'.repeat(2*1024*1024+1)]) await assert.rejects(readSubtitles(detail([{url}]),{},async()=>new Response(body)),/SUBTITLE_DOWNLOAD_FAILED/);
});
