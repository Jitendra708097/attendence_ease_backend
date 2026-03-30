function getPagination(query = {}) {
  const page = Number.parseInt(query.page, 10) || 1;
  const limit = Math.min(Number.parseInt(query.limit, 10) || 20, 100);
  const offset = (page - 1) * limit;

  return {
    page,
    limit,
    offset,
  };
}

function getPagingData(result, page, limit) {
  return {
    rows: result.rows,
    count: result.count,
    page,
    limit,
    totalPages: Math.ceil(result.count / limit) || 1,
  };
}

module.exports = {
  getPagination,
  getPagingData,
};
