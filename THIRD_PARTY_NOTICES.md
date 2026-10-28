# Third-party notices

DyTranOb is an independent implementation of a Douyin / OneBot interoperability runtime.

- [douyin-im](https://github.com/zhinjs/douyin-im), by Zhin.js, MIT. Used as an npm dependency for native Douyin sessions. Its package includes additional third-party notices, which remain applicable.
- [OneBot v11 specification](https://github.com/botuniverse/onebot-11). Referenced for the action, event and transport formats.
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) and [NapCatQQ](https://github.com/NapNeko/NapCatQQ) were reviewed as architectural references. Their code and assets are not included in DyTranOb.
- The Model Context Protocol TypeScript SDK, ws, Zod and the remaining npm dependencies retain their own licenses. See the installed packages and package-lock.json for exact versions.
- [Rockedw/douyin-web-api-sdk](https://github.com/Rockedw/douyin-web-api-sdk) was reviewed for its public SDK feature set and observed web protocol behavior. TypeScript request handlers are independently implemented. `src/emoji-catalog.ts` records factual names, URLs, dimensions and availability windows from its public dynamic emoji metadata (reviewed 2026-10-27). Those URLs identify Douyin platform assets; no ownership or license to the assets is implied. The Java source and protobuf templates are not bundled.
- [TeamBreakerr/douyin-chat-export](https://github.com/TeamBreakerr/douyin-chat-export) and [sisi0318/jumpbyte-bot](https://github.com/sisi0318/jumpbyte-bot) were reviewed during media compatibility research; their source code is not bundled.

DyTranOb does not represent Douyin or the authors of these projects. Use only accounts and conversations you are authorized to access.

- [ucmao/media-parser](https://github.com/ucmao/media-parser), especially its Douyin parser documentation, was reviewed for factual endpoint, subtitle-field and timed-text format behavior (2026-10-28). The TypeScript handlers and parser are independently implemented; no Python source or assets are bundled.
