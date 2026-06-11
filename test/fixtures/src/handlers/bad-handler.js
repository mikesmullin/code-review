// Fixture: a handler that does NOT validate input and leaks a debug log.
export function deleteAccount(req) {
  console.log('deleting account for', req.body);
  const id = req.body.id; // used directly, no validation
  db.delete(id);
  return { deleted: id };
}
