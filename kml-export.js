window.ProgressKml = (() => {
  // KML alpha is the first byte in AABBGGRR. 0x59 means 35% opacity,
  // equivalent to 65% transparency after integer alpha quantization.
  const KML_ALPHA = '59';
  const WGS84 = 'EPSG:4326';

  function xmlEscape(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  }

  function projectionName(crs) {
    if (!crs) return WGS84; // RFC 7946 GeoJSON uses WGS84 longitude/latitude.
    if (typeof crs === 'string') return crs;
    const properties = crs.properties || {};
    return properties.name || properties.href || properties.code || crs.name || WGS84;
  }

  function projectionDefinition(crs) {
    const name = String(projectionName(crs)).trim();
    if (/CRS:?84/i.test(name) || /EPSG[:/]+(?:0\/)?(?:4326|4979)$/i.test(name)) return WGS84;
    const epsgMatch = name.match(/EPSG[:/]+(?:0\/)?(\d+)/i);
    const code = epsgMatch ? `EPSG:${epsgMatch[1]}` : name;
    if (code === 'EPSG:900913') return 'EPSG:3857';
    if (code === 'EPSG:3857' && window.proj4?.defs && !window.proj4.defs(code)) {
      window.proj4.defs(code, '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs +type=crs');
    }
    const utmMatch = code.match(/^EPSG:(326|327)(\d{2})$/);
    if (utmMatch && window.proj4?.defs && !window.proj4.defs(code)) {
      const south = utmMatch[1] === '327' ? ' +south' : '';
      window.proj4.defs(code, `+proj=utm +zone=${Number(utmMatch[2])}${south} +datum=WGS84 +units=m +no_defs +type=crs`);
    }
    return code;
  }

  function makeProjector(crs) {
    const source = projectionDefinition(crs);
    if (source === WGS84) return (x, y) => [x, y];
    if (typeof window.proj4 !== 'function') throw new Error('Pustaka konversi koordinat belum termuat. Muat ulang halaman dan coba lagi.');
    return (x, y) => {
      let result;
      try { result = window.proj4(source, WGS84, [x, y]); }
      catch (error) { throw new Error(`Sistem koordinat ${source} tidak dapat dikonversi ke WGS84: ${error.message || error}`); }
      if (!Array.isArray(result) || !Number.isFinite(result[0]) || !Number.isFinite(result[1])) {
        throw new Error(`Koordinat dari ${source} tidak menghasilkan posisi WGS84 yang valid.`);
      }
      return result;
    };
  }

  function kmlPosition(position, project) {
    if (!Array.isArray(position) || position.length < 2) throw new Error('Ada koordinat polygon yang tidak valid.');
    const [longitude, latitude] = project(Number(position[0]), Number(position[1]));
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
      throw new Error('Koordinat polygon berada di luar rentang WGS84. Pastikan GeoJSON memiliki informasi CRS atau unggah SHP dengan file PRJ.');
    }
    const values = [longitude, latitude];
    if (position.length > 2 && Number.isFinite(Number(position[2]))) values.push(Number(position[2]));
    return values.join(',');
  }

  function pointInRing(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
      if (Math.abs(cross) < 1e-12 && x >= Math.min(xi, xj) - 1e-12 && x <= Math.max(xi, xj) + 1e-12 && y >= Math.min(yi, yj) - 1e-12 && y <= Math.max(yi, yj) + 1e-12) return true;
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function insidePolygon(point, rings) {
    return !!rings?.length && pointInRing(point, rings[0]) && !rings.slice(1).some(ring => pointInRing(point, ring));
  }

  function ringArea(ring) {
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(area / 2);
  }

  function interiorPoint(rings) {
    const outer = rings?.[0] || [];
    if (outer.length < 4) throw new Error('Polygon tidak memiliki cincin luar yang valid.');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of outer) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const area2 = outer.reduce((sum, point, index) => {
      const next = outer[(index + 1) % outer.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    if (Math.abs(area2) > 1e-14) {
      let cx = 0, cy = 0;
      for (let i = 0; i < outer.length; i++) {
        const a = outer[i], b = outer[(i + 1) % outer.length], cross = a[0] * b[1] - b[0] * a[1];
        cx += (a[0] + b[0]) * cross; cy += (a[1] + b[1]) * cross;
      }
      const centroid = [cx / (3 * area2), cy / (3 * area2)];
      if (insidePolygon(centroid, rings)) return centroid;
    }
    let best = null, bestWidth = -1;
    for (let step = 1; step < 128; step++) {
      const y = minY + (maxY - minY) * step / 128;
      const intersections = [];
      for (const ring of rings) for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
        if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) intersections.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i++) {
        const point = [(intersections[i] + intersections[i + 1]) / 2, y], width = intersections[i + 1] - intersections[i];
        if (width > bestWidth && insidePolygon(point, rings)) { best = point; bestWidth = width; }
      }
    }
    if (best) return best;
    const fallback = [(minX + maxX) / 2, (minY + maxY) / 2];
    if (insidePolygon(fallback, rings)) return fallback;
    throw new Error('Tidak dapat menemukan titik label di dalam polygon. Periksa geometri zona.');
  }

  function polygonXml(rings, project) {
    if (!Array.isArray(rings) || !rings.length) throw new Error('Geometri zona tidak memiliki cincin polygon.');
    const ringXml = rings.map((ring, index) => {
      const points = ring.map(position => kmlPosition(position, project)).join(' ');
      const tag = index === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs';
      return `<${tag}><LinearRing><coordinates>${points}</coordinates></LinearRing></${tag}>`;
    }).join('');
    return `<Polygon><tessellate>1</tessellate>${ringXml}</Polygon>`;
  }

  function hslToHex(hue, saturation = 0.78, lightness = 0.53) {
    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const h = hue / 60;
    const x = c * (1 - Math.abs(h % 2 - 1));
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    const m = lightness - c / 2;
    return `#${[r, g, b].map(value => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  }

  function toKmlColor(hex) {
    const value = hex.replace('#', '');
    return `${KML_ALPHA}${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`.toUpperCase();
  }

  function extendedData(zone, partType, sourceProperties) {
    const values = [
      ['NOZN', zone.zone], ['part_type', partType], ['jumlah_sample', zone.sampleCount],
      ['surveyor', zone.surveyor], ['kabupaten', zone.city]
    ];
    const reserved = new Set(['nozn', 'nozn', 'parttype', 'jumlahsample', 'surveyor', 'kabupaten', '_zonesurveyors', '_progresszone']);
    for (const [name, value] of Object.entries(sourceProperties || {})) {
      const normalized = name.toLocaleLowerCase('id-ID').replace(/[^a-z0-9]/g, '');
      if (value == null || reserved.has(normalized) || (typeof value === 'string' && value.trim() === '')) continue;
      values.push([name, typeof value === 'object' ? JSON.stringify(value) : value]);
    }
    return values.map(([name, value]) => `<Data name="${xmlEscape(name)}"><value>${xmlEscape(value)}</value></Data>`).join('');
  }

  function buildRemainingZonesKml(zones, surveyor, cityLabel) {
    if (!Array.isArray(zones) || !zones.length) throw new Error('Tidak ada zona tersisa untuk dibuat menjadi KML.');
    const styles = ['<Style id="singlepart-white"><IconStyle><scale>0</scale></IconStyle><LabelStyle><color>ff000000</color><scale>1.0</scale></LabelStyle><LineStyle><color>59FFFFFF</color><width>1.2</width></LineStyle><PolyStyle><color>59FFFFFF</color><fill>1</fill><outline>1</outline></PolyStyle></Style>'];
    const folders = new Map();
    let multipartIndex = 0;
    for (const zone of zones) {
      const polygons = [];
      let sourceWasMultiPolygon = false;
      for (const geometry of zone.geometries || []) {
        if (geometry?.type === 'Polygon') polygons.push(geometry.coordinates);
        else if (geometry?.type === 'MultiPolygon') { sourceWasMultiPolygon = true; polygons.push(...geometry.coordinates); }
        else throw new Error(`Zona ${zone.zone} memiliki geometri yang bukan Polygon atau MultiPolygon.`);
      }
      if (!polygons.length) throw new Error(`Zona ${zone.zone} tidak mempunyai bagian polygon.`);
      const partType = sourceWasMultiPolygon || polygons.length > 1 ? 'multipart' : 'singlepart';
      let styleId = 'singlepart-white';
      if (partType === 'multipart') {
        styleId = `multipart-${multipartIndex}`;
        const hex = hslToHex((multipartIndex * 137.50776405) % 360);
        styles.push(`<Style id="${styleId}"><IconStyle><scale>0</scale></IconStyle><LabelStyle><color>ff000000</color><scale>1.0</scale></LabelStyle><LineStyle><color>${toKmlColor(hex)}</color><width>1.2</width></LineStyle><PolyStyle><color>${toKmlColor(hex)}</color><fill>1</fill><outline>1</outline></PolyStyle></Style>`);
        multipartIndex++;
      }
      const project = makeProjector(zone.crs);
      const transformedPolygons = polygons.map(rings => rings.map(ring => ring.map(position => {
        const [longitude, latitude] = project(Number(position[0]), Number(position[1]));
        if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error(`Zona ${zone.zone} menghasilkan koordinat di luar WGS84. Periksa informasi CRS.`);
        return [longitude, latitude, ...(position.length > 2 ? position.slice(2) : [])];
      })));
      let labelPolygon = transformedPolygons[0], largest = -1;
      for (const rings of transformedPolygons) { const area = ringArea(rings[0] || []); if (area > largest) { largest = area; labelPolygon = rings; } }
      const label = interiorPoint(labelPolygon);
      const geometryXml = transformedPolygons.map(polygon => polygonXml(polygon, (x, y) => [x, y]));
      geometryXml.push(`<Point><coordinates>${label[0]},${label[1]},0</coordinates></Point>`);
      const placemark = `<Placemark><name>${xmlEscape(zone.zone)}</name><visibility>1</visibility><styleUrl>#${styleId}</styleUrl><ExtendedData>${extendedData(zone, partType, zone.properties)}</ExtendedData><MultiGeometry>${geometryXml.join('')}</MultiGeometry></Placemark>`;
      const folderName = zone.city || cityLabel || 'Kabupaten';
      if (!folders.has(folderName)) folders.set(folderName, []);
      folders.get(folderName).push(placemark);
    }
    const folderXml = [...folders].map(([name, placemarks]) => `<Folder><name>${xmlEscape(name)}</name><visibility>1</visibility>${placemarks.join('')}</Folder>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>KML Sisa - ${xmlEscape(surveyor)}</name><visibility>1</visibility>${styles.join('')}${folderXml}</Document></kml>`;
  }

  return { buildRemainingZonesKml };
})();
