module.exports = (sequelize, DataTypes) => {
  const LeaveType = sequelize.define(
    'LeaveType',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      code: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      description: DataTypes.TEXT,
      is_paid: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      half_day_allowed: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      include_weekends: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      include_holidays: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      allow_negative_balance: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
      },
      max_negative_balance: {
        type: DataTypes.DECIMAL(6, 1),
        defaultValue: 0,
      },
      notice_days: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      max_consecutive_days: DataTypes.INTEGER,
      min_request_days: {
        type: DataTypes.DECIMAL(6, 1),
        defaultValue: 0.5,
      },
      max_request_days: DataTypes.DECIMAL(6, 1),
      requires_document_after_days: DataTypes.DECIMAL(6, 1),
      yearly_default_balance: {
        type: DataTypes.DECIMAL(6, 1),
        defaultValue: 0,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      sort_order: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      settings: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'leave_types',
      paranoid: true,
      underscored: true,
      indexes: [
        { fields: ['org_id', 'code'], unique: true },
        { fields: ['org_id', 'is_active'] },
      ],
    }
  );

  LeaveType.associate = (models) => {
    LeaveType.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    LeaveType.hasMany(models.LeaveRequest, { foreignKey: 'leave_type_id', as: 'requests' });
    LeaveType.hasMany(models.LeaveBalanceLedger, { foreignKey: 'leave_type_id', as: 'ledgerEntries' });
  };

  return LeaveType;
};
