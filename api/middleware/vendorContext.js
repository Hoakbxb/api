function normalizeVendorId(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  return s ? s : null;
}

function getVendorIdFromReq(req) {
  // Prefer explicit vendor context from header/query/body.
  const headerVal =
    (typeof req.get === 'function' && (req.get('x-vendor-id') || req.get('x_vendor_id'))) ||
    req.headers?.['x-vendor-id'] ||
    req.headers?.['x_vendor_id'];
  const queryVal = req.query?.vendor_id;
  const bodyVal = req.body?.vendor_id;

  return (
    normalizeVendorId(headerVal) ||
    normalizeVendorId(queryVal) ||
    normalizeVendorId(bodyVal)
  );
}

module.exports = {
  getVendorIdFromReq,
};
