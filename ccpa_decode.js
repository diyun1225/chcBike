/*
 * CcpaDecoder — CCPA CAN 解封包器(把原始 CAN frame 解析成車況數值)
 * 參考自 sdkTest/src/ccpa_telemetry.c。協議對照表見 PROTOCOL.md。
 *
 * ── 純 HTML ───────────────────────────────────────────────
 *      <script src="ccpa_decode.js"></script>
 *      <script>
 *        const dec = new CcpaDecoder();
 *        dec.feed("ID=0x29404FC DLC=6 DATA=C4 09 DC 05 50 00");
 *        console.log(dec.snapshot());   // { speedKph: 25, cadenceRpm: 80, ... }
 *      </script>

 * ── API ────────────────────────────────────────────────────────────────────
 *   const dec = new CcpaDecoder();
 *   dec.feed(rawLine)            // 丟"ID=.. DLC=.. DATA=.." 並解封包
 *                                // 回傳解出的 {id,dlc,data} 或 null
 *   dec.snapshot()               // 乾淨物件:只給有效值,無效給 null
 *   dec.reset()                  // 清空狀態
 *   CcpaDecoder.parseRawLine(s)  // 靜態:把文字行拆成 {id,dlc,data},不需 new
 */
(function (root) {
  "use strict";

  // CAN ID(對應 ccpa_telemetry.c 的 #define)。同一筆資料常有 ACK / BRO 兩個 ID,內容相同。
  const ID = {
    GENERAL_INFO00ACK: 0x29404FC, GENERAL_INFO00BRO: 0x29404FE,
    GENERAL_INFO01ACK: 0x29404F8, GENERAL_INFO01BRO: 0x29404FA,
    ASSISTREQ: 0x2940015,
    CONTROLLER_INFO00ACK: 0x1E942040, CONTROLLER_INFO00BRO: 0x1E942042,
    CONTROLLER_INFO02ACK: 0x1E942048, CONTROLLER_INFO02BRO: 0x1E94204A,
    CONTROLLER_INFO03ACK: 0x1E94204C, CONTROLLER_INFO03BRO: 0x1E94204E,
    BAT1_INFO01ACK: 0x1E942444, BAT1_INFO01BRO: 0x1E942446,
    BAT1_INFO06ACK: 0x1E942458, BAT1_INFO06BRO: 0x1E94245A,
    REARDERAILLEUR_INFO00ACK: 0x1E944840, REARDERAILLEUR_INFO00BRO: 0x1E944842,
  };

  // 來源優先序:GENERAL_INFO 一旦給過值就鎖定,忽略 DEVICE 來源的同名值(避免兩邊打架)。
  const SRC = { NONE: 0, GENERAL: 1, DEVICE: 2 };

  const u16le = (d, i) => d[i] | (d[i + 1] << 8);
  const u24le = (d, i) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16);
  const tempC = (raw) => raw - 64;

  class CcpaDecoder {
    constructor() {
      this.reset();
    }

    reset() {
      this.state = {
        bikeSpeedValid: false, bikeSpeedKph: 0, bikeSpeedSource: SRC.NONE,
        cadenceValid: false, cadenceRpm: 0, cadenceSource: SRC.NONE,
        riderTorqueValid: false, riderTorqueNm: 0, riderTorqueSource: SRC.NONE,
        motorRpmValid: false, motorRpm: 0,
        motorTemperatureValid: false, motorTemperatureC: 0,
        assistLevelValid: false, assistLevel: 0,
        batterySocValid: false, batterySocPct: 0, batterySocSource: SRC.NONE,
        batteryVoltageValid: false, batteryVoltageMv: 0,
        batteryCurrentValid: false, batteryCurrentMa: 0,
        batteryTempsValid: [false, false, false, false], batteryTempsC: [0, 0, 0, 0],
        rearGearValid: false, rearGearIndex: 0, rearGearMax: 0, rearGearSource: SRC.NONE,
      };
    }

    // 餵一行 "ID=.. DLC=.. DATA=.." 文字 → 解析 + 解封包(更新內部狀態)。
    // 回傳解出的 {id, dlc, data},解析失敗回傳 null。
    feed(line) {
      const f = CcpaDecoder.parseRawLine(line);
      if (!f) return null;

      const s = this.state;
      const d = f.data;
      const dlc = d.length;

      switch (f.id) {
        case ID.GENERAL_INFO00ACK:
        case ID.GENERAL_INFO00BRO:
          if (dlc >= 6) {
            const sp = u16le(d, 0);
            if (sp !== 0xFFFF) { s.bikeSpeedKph = sp * 0.01; s.bikeSpeedValid = true; s.bikeSpeedSource = SRC.GENERAL; }
            else { s.bikeSpeedValid = false; s.bikeSpeedSource = SRC.NONE; }
            s.cadenceRpm = d[4]; s.cadenceValid = true; s.cadenceSource = SRC.GENERAL;
            const tq = u16le(d, 2);
            if (tq !== 0xFFFF && tq !== 0x0000) { s.riderTorqueNm = tq * 0.01; s.riderTorqueValid = true; s.riderTorqueSource = SRC.GENERAL; }
            else { s.riderTorqueValid = false; s.riderTorqueSource = SRC.NONE; }
            // 助力等級在 byte5 的 bit2~5(0~5 有效,6=NULL)。這包定時廣播,所以這裡讀得到。
            const lvl = (d[5] >> 2) & 0x0F;
            if (lvl <= 5) { s.assistLevel = lvl; s.assistLevelValid = true; }
            else { s.assistLevelValid = false; }
          }
          break;

        case ID.ASSISTREQ:
          if (dlc >= 2) {
            const l = d[1] & 0x0F;
            if (l <= 5) { s.assistLevel = l; s.assistLevelValid = true; }
            else if (l === 6) { s.assistLevelValid = false; }
          }
          break;

        case ID.GENERAL_INFO01ACK:
        case ID.GENERAL_INFO01BRO:
          if (dlc >= 5) {
            if (d[4] !== 0xFF && d[4] !== 0x00) { s.batterySocPct = d[4]; s.batterySocValid = true; s.batterySocSource = SRC.GENERAL; }
            else { s.batterySocValid = false; s.batterySocSource = SRC.NONE; }
          }
          break;

        case ID.CONTROLLER_INFO00ACK:
        case ID.CONTROLLER_INFO00BRO:
          if (dlc >= 2 && s.bikeSpeedSource !== SRC.GENERAL) {
            const sp = u16le(d, 0);
            if (sp !== 0xFFFF) { s.bikeSpeedKph = sp * 0.01; s.bikeSpeedValid = true; s.bikeSpeedSource = SRC.DEVICE; }
          }
          break;

        case ID.CONTROLLER_INFO02ACK:
        case ID.CONTROLLER_INFO02BRO:
          if (dlc >= 7) {
            s.motorRpm = u16le(d, 4); s.motorRpmValid = true;
            s.motorTemperatureC = tempC(d[6]); s.motorTemperatureValid = true;
          }
          break;

        case ID.CONTROLLER_INFO03ACK:
        case ID.CONTROLLER_INFO03BRO:
          if (dlc >= 4 && s.cadenceSource !== SRC.GENERAL) { s.cadenceRpm = d[3]; s.cadenceValid = true; s.cadenceSource = SRC.DEVICE; }
          if (dlc >= 6 && s.riderTorqueSource !== SRC.GENERAL) { s.riderTorqueNm = u16le(d, 4) * 0.1; s.riderTorqueValid = true; s.riderTorqueSource = SRC.DEVICE; }
          break;

        case ID.BAT1_INFO01ACK:
        case ID.BAT1_INFO01BRO:
          if (dlc >= 7) {
            s.batteryVoltageMv = u24le(d, 0); s.batteryVoltageValid = true;
            s.batteryCurrentMa = u16le(d, 4); s.batteryCurrentValid = true;
            if (s.batterySocSource !== SRC.GENERAL && d[6] !== 0xFF) { s.batterySocPct = d[6]; s.batterySocValid = true; s.batterySocSource = SRC.DEVICE; }
          }
          break;

        case ID.BAT1_INFO06ACK:
        case ID.BAT1_INFO06BRO:
          if (dlc >= 4) {
            for (let i = 0; i < 4; i++) { s.batteryTempsC[i] = tempC(d[i]); s.batteryTempsValid[i] = true; }
          }
          break;

        case ID.REARDERAILLEUR_INFO00ACK:
        case ID.REARDERAILLEUR_INFO00BRO:
          if (dlc >= 2) { s.rearGearIndex = d[0]; s.rearGearMax = d[1]; s.rearGearValid = true; s.rearGearSource = SRC.DEVICE; }
          break;

        default:
          break; // 其他 ID(含 HMI_INFO00)目前不解析
      }
      return f;
    }

    // 乾淨快照:只給有效值,無效的給 null。適合直接丟給 UI 或轉 JSON。
    snapshot() {
      const s = this.state;
      return {
        speedKph: s.bikeSpeedValid ? s.bikeSpeedKph : null,
        cadenceRpm: s.cadenceValid ? s.cadenceRpm : null,
        torqueNm: s.riderTorqueValid ? s.riderTorqueNm : null,
        motorRpm: s.motorRpmValid ? s.motorRpm : null,
        motorTempC: s.motorTemperatureValid ? s.motorTemperatureC : null,
        assistLevel: s.assistLevelValid ? s.assistLevel : null,
        batterySocPct: s.batterySocValid ? s.batterySocPct : null,
        batteryVoltageMv: s.batteryVoltageValid ? s.batteryVoltageMv : null,
        batteryCurrentMa: s.batteryCurrentValid ? s.batteryCurrentMa : null,
        batteryTempsC: s.batteryTempsC.map((t, i) => (s.batteryTempsValid[i] ? t : null)),
        rearGear: s.rearGearValid ? { index: s.rearGearIndex, max: s.rearGearMax } : null,
      };
    }

    // 把 "ID=0x01E942446 DLC=8 DATA=AA BB CC ..." 拆成 {id, dlc, data:[...]}。解不出回傳 null。
    static parseRawLine(line) {
      const m = /ID=0x([0-9A-Fa-f]+)\s+DLC=(\d+)\s+DATA=([0-9A-Fa-f ]*)/.exec(line);
      if (!m) return null;
      const id = parseInt(m[1], 16);
      const dlc = parseInt(m[2], 10);
      const bytes = m[3].trim().split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
      return { id, dlc, data: bytes.slice(0, dlc) };
    }
  }

  // 同時支援:純 <script>(全域)、Node/CommonJS(require)。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { CcpaDecoder };
  }
  root.CcpaDecoder = CcpaDecoder;
})(typeof globalThis !== "undefined" ? globalThis : this);
