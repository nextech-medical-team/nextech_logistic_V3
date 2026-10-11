export function existingParcelShop(source={}) {
 if(source.shopifyRelay?.selectedId)return source.shopifyRelay.selectedId;
 const values=[source,source.shopifyOrder||{}];
 for(const v of values)for(const k of ['glsParcelShopId','parcelShopId','parcel_shop_id','parcelshopid'])if(String(v[k]||'').trim())return String(v[k]).trim();
 for(const a of source.note_attributes||[])if(/^(glsParcelShopId|parcelShopId|parcel_shop_id|parcelshopid)$/i.test(a.name||'')&&String(a.value||'').trim())return String(a.value).trim();
 return null;
}
export function parcelShopSearch(address={}) {
 const street=String(address.street||'').replace(/\s+/g,' ').trim();
 const trailing=street.match(/^(.*?)[,\s]+(\d+[A-Za-z0-9\-/]*)$/),leading=street.match(/^(\d+[A-Za-z0-9\-/]*)\s+(.*)$/);
 const name=trailing?trailing[1]:leading?leading[2]:street,number=trailing?trailing[2]:leading?leading[1]:'';
 const country=String(address.country||'').trim().toUpperCase(),postal=String(address.postal||'').replace(/\s+/g,'').toUpperCase(),city=String(address.city||'').trim();
 if(!/^[A-Z]{2}$/.test(country)||!postal||!city)throw new Error('Recherche relais GLS : pays, code postal et ville requis');
 return {...(name?{Street:name}:{}),...(number?{StreetNumber:number}:{}),CountryCode:country,ZIPCode:postal,City:city,MaxNumberOfShops:20,Distance:'50'};
}
export function normalizeParcelShops(payload) {
 const rows=payload?.ParcelShop||payload?.ListOfParcelShop?.ParcelShop||[];
 return (Array.isArray(rows)?rows:[]).filter(p=>String(p.ParcelShopID||'').trim()).map(p=>({parcelShopId:String(p.ParcelShopID).trim(),address:p.Address||null,distance:p.AirlineDistance!==null&&p.AirlineDistance!==undefined&&p.AirlineDistance!==''&&Number.isFinite(Number(p.AirlineDistance))?Number(p.AirlineDistance):null})).sort((a,b)=>(a.distance??Infinity)-(b.distance??Infinity));
}
