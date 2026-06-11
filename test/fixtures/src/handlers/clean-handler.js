// Fixture: a clean handler that validates its input at the boundary.
export function getUser(req) {
  const id = req?.params?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('invalid id');
  }
  return { id };
}
